import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import {
  buildBatchContext,
  buildContext,
  DEFAULT_PILL_MODEL,
  DEFAULT_WEBHOOK_OPTIONS,
  renderBatchRequest,
  renderRequest,
  sampleReading,
  type Brew,
  type Offsets,
  type Pill,
  type PillModel,
  type Reading,
  type RenderedRequest,
  type Webhook,
  type WebhookDelivery,
  type WebhookExport,
  type WebhookInput,
  type WebhookStatus,
} from '@rapthooker/shared';
import type { RawReading, Store, WebhookStateRow } from './db.js';
import type { Logger } from './log.js';
import { calibrate, type Derived } from './pills.js';

export class WebhookError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface WebhookDeps {
  pills: {
    get(id: string): Pill | null;
    activeIds(): string[];
    latest(id: string): Reading | null;
    /** Used to replay stored readings (catch-up); no offsets and the pill's own values when missing. */
    offsets?(id: string): Offsets;
    model?(id: string): PillModel;
    /** RaptHooker's own velocity and smoothed gravity at a stored reading's time (catch-up). */
    derivedAt?(id: string, ts: number): Derived;
  };
  brews: { activeFor(pillId: string): Brew | null };
  /** False until the clock can be trusted after boot. */
  clockTrusted: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  version: string;
  /** The hub's name, for {{hub_name}}. */
  hubName?: () => string;
}

/** Retry delays after a failed send, capped at the webhook's own interval. */
const BACKOFF_MIN = [1, 2, 5, 10, 30, 60];
/** Leeway so a service measuring "once per 15 minutes" from its own clock doesn't drop a send. */
const INTERVAL_GRACE_MS = 5000;
const MAX_STALE_MS = 24 * 3_600_000;
const BODY_LOG_LIMIT = 4000;
const RESPONSE_LOG_LIMIT = 2000;
/** Catch-up sends missed readings at most this fast per webhook… */
export const CATCH_UP_PER_MIN = 10;
/** …and goes back at most this far. */
export const CATCH_UP_MAX_MS = 7 * 86_400_000;
/** Windows skipped (below the change thresholds) per pill and check while catching up. */
const CATCH_UP_SKIPS = 50;

const SECRET = '••••••';
const SKIP_IMPLAUSIBLE = 'Not sent: the latest reading looks wrong (is the pill floating?)';

type PillRef = Pick<Pill, 'id' | 'name' | 'address' | 'raptId' | 'info'>;

interface Item {
  pill: PillRef;
  reading: Reading;
}

/** What to do for one webhook and pill right now. */
type Plan =
  | { kind: 'none' }
  | { kind: 'skip'; reason: string }
  | { kind: 'catchup'; reading: Reading }
  | { kind: 'send'; reading: Reading; spaced: boolean };

const NONE: Plan = { kind: 'none' };

/** Hides keys and tokens from people who aren't the owner. */
export function maskWebhook(hook: Webhook): Webhook {
  let url: string;
  try {
    const u = new URL(hook.url.replace(/\{\{[^}]*\}\}/g, 'x'));
    url = `${u.protocol}//${u.host}/${SECRET}`;
  } catch {
    url = SECRET;
  }
  return {
    ...hook,
    url,
    headers: hook.headers.map((h) => ({ name: h.name, value: SECRET })),
    body: '',
    batchBody: '',
    masked: true,
    status: maskStatus(hook.status),
  };
}

/** Error text can quote the URL (and whatever key is in it), so viewers only see that a send failed. */
export function maskStatus(status: WebhookStatus): WebhookStatus {
  return {
    ...status,
    lastError: status.lastError === null ? null : status.lastHttpStatus ? `HTTP ${status.lastHttpStatus}` : 'Send failed',
  };
}

/** Takes URLs out of an error message before it's stored. */
const scrubUrls = (text: string): string => text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '(the URL)');

/**
 * fetch only takes header values it can send as one byte per character (Latin-1). Anything beyond that, like an emoji
 * in a pill's name, goes out as its UTF-8 bytes (as curl sends it) instead of failing every send.
 */
const headerBytes = (value: string): string => (/[\u0100-\u{10ffff}]/u.test(value) ? Buffer.from(value, 'utf8').toString('latin1') : value);

/** A saved webhook with the options added since it was saved. */
export function upgradeWebhook(saved: Partial<WebhookInput>): WebhookInput {
  return { ...DEFAULT_WEBHOOK_OPTIONS, ...saved } as WebhookInput;
}

/** The webhook's settings without its id and status. */
export function webhookInput(hook: Webhook): WebhookInput {
  const { id: _id, createdAt: _c, updatedAt: _u, masked: _m, status: _s, ...input } = hook;
  return input;
}

export const isPaused = (hook: Pick<WebhookInput, 'pausedUntil'>, now: number): boolean =>
  hook.pausedUntil !== null && now < hook.pausedUntil;

/**
 * Sends each pill's latest reading to every enabled webhook on its own schedule. When it last sent to each one is
 * stored, so restarts neither repeat a send nor flood a service with the readings missed while it was down (unless
 * the webhook asks to catch up).
 */
export class WebhookService extends EventEmitter {
  private hooks = new Map<string, Webhook>();
  private states = new Map<string, WebhookStateRow>();
  /** Why a webhook × pill's latest reading is being held back. */
  private skips = new Map<string, string>();
  /** Recent catch-up sends per webhook, for the rate limit. */
  private catchUpSends = new Map<string, number[]>();
  private inFlight = new Set<string>();
  private running = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private stopped = false;
  private stmts: { first: StatementSync; last: StatementSync } | undefined;

  constructor(
    private readonly store: Store,
    private readonly deps: WebhookDeps,
    private readonly log: Logger,
  ) {
    super();
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  load(): void {
    for (const row of this.store.listWebhookRows()) {
      const input = upgradeWebhook(JSON.parse(row.json) as Partial<WebhookInput>);
      this.hooks.set(row.id, {
        ...input,
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        masked: false,
        status: emptyStatus(),
      });
    }
    for (const s of this.store.webhookStates()) this.states.set(`${s.webhook_id}|${s.pill_id}`, s);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.idle();
  }

  list(): Webhook[] {
    return [...this.hooks.values()].map((h) => this.withStatus(h));
  }

  get(id: string): Webhook | null {
    const h = this.hooks.get(id);
    return h ? this.withStatus(h) : null;
  }

  create(input: WebhookInput): Webhook {
    const hook = this.insert(input);
    void this.tick();
    return this.withStatus(hook);
  }

  update(id: string, input: WebhookInput): Webhook {
    const old = this.hooks.get(id);
    if (!old) throw new WebhookError('Unknown webhook', 404);
    const now = this.now();
    const hook: Webhook = { ...old, ...input, updatedAt: now };
    this.hooks.set(id, hook);
    this.store.saveWebhook(id, webhookInput(hook), hook.createdAt, hook.updatedAt);
    const wasOff = !old.enabled || isPaused(old, now);
    const isOn = hook.enabled && !isPaused(hook, now);
    for (const s of this.statesFor(id)) {
      let next = s;
      // A changed destination gets a fresh start: no waiting out a failure backoff from the old settings.
      if (s.retry_at) next = { ...next, retry_at: null, failures: 0 };
      // Catch-up doesn't replay the time it was switched off or paused.
      if (wasOff && isOn) next = { ...next, cursor_ts: Math.max(next.cursor_ts ?? 0, now) };
      if (next !== s) this.saveState(next);
    }
    this.changed(id);
    void this.tick();
    return this.withStatus(hook);
  }

  setEnabled(id: string, enabled: boolean): Webhook {
    const old = this.hooks.get(id);
    if (!old) throw new WebhookError('Unknown webhook', 404);
    return this.update(id, { ...webhookInput(old), enabled });
  }

  /** Pauses until a time, or resumes with null. */
  pause(id: string, until: number | null): Webhook {
    const old = this.hooks.get(id);
    if (!old) throw new WebhookError('Unknown webhook', 404);
    const pausedUntil = until !== null && until > this.now() ? until : null;
    return this.update(id, { ...webhookInput(old), pausedUntil });
  }

  /** A switched-off copy named "<name> (copy)". */
  duplicate(id: string): Webhook {
    const old = this.hooks.get(id);
    if (!old) throw new WebhookError('Unknown webhook', 404);
    return this.create({ ...webhookInput(old), name: `${old.name.slice(0, 73)} (copy)`, enabled: false, pausedUntil: null });
  }

  delete(id: string): void {
    if (!this.hooks.delete(id)) throw new WebhookError('Unknown webhook', 404);
    this.store.deleteWebhook(id);
    for (const key of [...this.states.keys()]) if (key.startsWith(`${id}|`)) this.states.delete(key);
    for (const key of [...this.skips.keys()]) if (key.startsWith(`${id}|`)) this.skips.delete(key);
    this.catchUpSends.delete(id);
  }

  /** Every webhook with its secrets, for "Export webhooks". */
  exportAll(): WebhookExport {
    return {
      app: 'rapthooker',
      kind: 'webhooks',
      version: 1,
      exportedAt: this.now(),
      webhooks: [...this.hooks.values()].map(webhookInput),
    };
  }

  /**
   * Adds webhooks from an export, switched off. Pill choices are kept for the pills this hub has; a choice of pills
   * that are all unknown here becomes "all pills".
   */
  importAll(webhooks: WebhookInput[]): Webhook[] {
    return webhooks.map((w) => {
      let pillIds = w.pillIds;
      if (pillIds !== 'all' && pillIds.length > 0) {
        const here = pillIds.filter((id) => this.deps.pills.get(id) !== null);
        pillIds = here.length > 0 ? here : 'all';
      }
      return this.withStatus(this.insert({ ...upgradeWebhook(w), pillIds, enabled: false, pausedUntil: null }));
    });
  }

  deliveries(id: string, limit = 50): WebhookDelivery[] {
    return this.store.listDeliveries(id, limit);
  }

  /** What would be sent: the pill's latest reading (a sample when it has none), or every pill in batch mode. */
  preview(input: WebhookInput, pillId: string | null): RenderedRequest {
    const pill = pillId ? this.deps.pills.get(pillId) : null;
    return this.render(input, this.itemsFor(input, pill));
  }

  /** Sends straight away, ignoring the schedule; not counted as a regular send. */
  async test(input: WebhookInput, webhookId: string | null, pillId: string | null): Promise<WebhookDelivery> {
    const pill = pillId ? this.deps.pills.get(pillId) : null;
    if (pillId && !pill) throw new WebhookError('Unknown pill', 404);
    const items = this.itemsFor(input, pill);
    const request = this.render(input, items);
    if (!/^https?:\/\//i.test(request.url)) throw new WebhookError('The URL must start with http:// or https://');
    return this.send(webhookId ?? 'test', input.batch ? null : (items[0]?.pill.id ?? null), request, input.timeoutSec, true);
  }

  /** Checks every webhook and pill, sending whatever is due. Runs on a timer and whenever a reading arrives. */
  async tick(): Promise<void> {
    if (this.stopped || !this.deps.clockTrusted()) return;
    const jobs: Promise<void>[] = [];
    try {
      const now = this.now();
      for (const hook of this.hooks.values()) {
        if (!hook.enabled || isPaused(hook, now)) continue;
        if (hook.batch) jobs.push(this.job(`${hook.id}|*`, () => this.runBatch(hook.id)));
        else for (const pillId of this.pillsFor(hook)) jobs.push(this.job(`${hook.id}|${pillId}`, () => this.runSingle(hook.id, pillId)));
      }
    } catch (err) {
      this.log.error({ err: (err as Error).stack ?? String(err) }, 'checking webhooks failed');
    }
    await Promise.all(jobs);
  }

  /** Resolves once no sends are in progress. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  /** Runs one webhook × pill (or webhook batch) at a time; errors are logged, never thrown. */
  private job(key: string, fn: () => Promise<void>): Promise<void> {
    if (this.inFlight.has(key)) return Promise.resolve();
    this.inFlight.add(key);
    const job: Promise<void> = fn()
      .catch((err: unknown) => this.log.error({ err: (err as Error).stack ?? String(err), job: key }, 'webhook send failed'))
      .finally(() => {
        this.inFlight.delete(key);
        this.running.delete(job);
      });
    this.running.add(job);
    return job;
  }

  /** The webhook, if it should be sending now. */
  private live(id: string): Webhook | null {
    const hook = this.hooks.get(id);
    return hook && hook.enabled && !isPaused(hook, this.now()) && !this.stopped ? hook : null;
  }

  private async runSingle(hookId: string, pillId: string): Promise<void> {
    // Catch-up can send several missed readings in a row; anything else sends at most once.
    for (let n = 0; n <= CATCH_UP_PER_MIN; n++) {
      const hook = this.live(hookId);
      const pill = this.deps.pills.get(pillId);
      if (!hook || hook.batch || !pill) return;
      const now = this.now();
      const plan = this.plan(hook, pillId, now);
      this.note(hook.id, pillId, plan);
      if (plan.kind === 'catchup') {
        if (!this.takeCatchUp(hook.id, now)) return;
      } else if (plan.kind !== 'send' || !plan.spaced) return;
      const ok = await this.deliver(hook, [{ pill, reading: plan.reading }]);
      if (!ok || plan.kind !== 'catchup') return;
    }
  }

  /** One request with every pill that has something to send, once per interval (or faster while catching up). */
  private async runBatch(hookId: string): Promise<void> {
    for (let n = 0; n <= CATCH_UP_PER_MIN; n++) {
      const hook = this.live(hookId);
      if (!hook || !hook.batch) return;
      const now = this.now();
      const catchUps: Item[] = [];
      const sends: Item[] = [];
      for (const pillId of this.pillsFor(hook)) {
        const pill = this.deps.pills.get(pillId);
        if (!pill) continue;
        const plan = this.plan(hook, pillId, now);
        this.note(hook.id, pillId, plan);
        if (plan.kind === 'catchup') catchUps.push({ pill, reading: plan.reading });
        else if (plan.kind === 'send') sends.push({ pill, reading: plan.reading });
      }
      const catchingUp = catchUps.length > 0 && this.takeCatchUp(hook.id, now);
      const items = [...(catchingUp ? catchUps : []), ...(this.batchDue(hook, now) ? sends : [])];
      if (items.length === 0) return;
      const ok = await this.deliver(hook, items);
      if (!ok || !catchingUp) return;
    }
  }

  private pillsFor(hook: WebhookInput): string[] {
    const active = this.deps.pills.activeIds();
    return hook.pillIds === 'all' ? active : hook.pillIds.filter((id) => active.includes(id));
  }

  private plan(hook: Webhook, pillId: string, now: number): Plan {
    if (hook.onlyDuringBrew && !this.deps.brews.activeFor(pillId)) return NONE;
    const latest = this.deps.pills.latest(pillId);
    if (!latest) return NONE;
    const s = this.states.get(`${hook.id}|${pillId}`);
    if (s?.retry_at != null && now < s.retry_at) return NONE;
    if (s && hook.catchUp) {
      const missed = this.catchUpItem(hook, pillId, s, latest, now);
      if (missed) return { kind: 'catchup', reading: missed };
    }
    const failing = s?.last_ok === 0;
    if (now - latest.ts > MAX_STALE_MS) return NONE;
    if (s && hook.onlyNewReadings && !failing && s.last_reading_ts !== null && latest.ts <= s.last_reading_ts) return NONE;
    if (hook.skipImplausible && !latest.plausible) return { kind: 'skip', reason: SKIP_IMPLAUSIBLE };
    if (s && !failing && !changedEnough(hook, s, latest, s.last_sent_at === null ? null : now - s.last_sent_at)) {
      return { kind: 'skip', reason: thresholdReason(hook) };
    }
    const spaced = !s || failing || s.last_sent_at === null || now - s.last_sent_at >= hook.intervalMin * 60_000 + INTERVAL_GRACE_MS;
    return { kind: 'send', reading: latest, spaced };
  }

  /**
   * The oldest reading the destination missed while it was failing: the last reading in the first interval window
   * after the last successful send, if that window ended before the last attempt (so normal sending would have sent
   * it) and newer readings exist. Windows whose reading isn't worth sending (below the change thresholds, or looks
   * wrong) are skipped for good.
   */
  private catchUpItem(hook: Webhook, pillId: string, s: WebhookStateRow, latest: Reading, now: number): Reading | null {
    if (s.last_reading_ts === null || s.last_sent_at === null) return null;
    const interval = hook.intervalMin * 60_000;
    const brew = hook.onlyDuringBrew ? this.deps.brews.activeFor(pillId) : null;
    const resumedAt = hook.pausedUntil !== null && hook.pausedUntil <= now ? hook.pausedUntil : 0;
    let from = Math.max(s.last_reading_ts, s.cursor_ts ?? 0, now - CATCH_UP_MAX_MS, resumedAt, brew?.startedAt ?? 0);
    let state = s;
    for (let i = 0; i < CATCH_UP_SKIPS; i++) {
      const first = this.readingAfter(pillId, from, hook.skipImplausible);
      if (!first) return null;
      const end = from + Math.max(1, Math.ceil((first.ts - from) / interval)) * interval;
      if (end > s.last_sent_at || latest.ts <= end) return null;
      const raw = this.lastReadingIn(pillId, from, end, hook.skipImplausible) ?? first;
      const reading = calibrate(
        raw,
        this.deps.pills.offsets?.(pillId) ?? { gravity: 0, temperature: 0 },
        this.deps.pills.model?.(pillId) ?? DEFAULT_PILL_MODEL,
        // Smoothed and with RaptHooker's velocity as it was then, like a reading sent live.
        this.deps.pills.derivedAt?.(pillId, raw.ts),
      );
      const silentMs = state.last_reading_ts === null ? null : reading.ts - state.last_reading_ts;
      if ((!hook.skipImplausible || reading.plausible) && changedEnough(hook, state, reading, silentMs)) return reading;
      state = { ...state, cursor_ts: reading.ts };
      this.saveState(state);
      from = reading.ts;
    }
    return null;
  }

  private statements(): { first: StatementSync; last: StatementSync } {
    const cols = 'ts, sg, temp, velocity, battery, rssi, x, y, z, flags';
    this.stmts ??= {
      first: this.store.db.prepare(
        `SELECT ${cols} FROM readings WHERE pill_id = ? AND ts > ? AND (? = 0 OR flags & 1 = 0) ORDER BY ts LIMIT 1`,
      ),
      last: this.store.db.prepare(
        `SELECT ${cols} FROM readings WHERE pill_id = ? AND ts > ? AND ts <= ? AND (? = 0 OR flags & 1 = 0) ORDER BY ts DESC LIMIT 1`,
      ),
    };
    return this.stmts;
  }

  private readingAfter(pillId: string, after: number, plausibleOnly: boolean): RawReading | null {
    return (this.statements().first.get(pillId, after, plausibleOnly ? 1 : 0) as RawReading | undefined) ?? null;
  }

  private lastReadingIn(pillId: string, after: number, upTo: number, plausibleOnly: boolean): RawReading | null {
    return (this.statements().last.get(pillId, after, upTo, plausibleOnly ? 1 : 0) as RawReading | undefined) ?? null;
  }

  /** A batch goes out once per interval, or when a failed one is due a retry. */
  private batchDue(hook: Webhook, now: number): boolean {
    let last: WebhookStateRow | null = null;
    for (const pillId of this.pillsFor(hook)) {
      const s = this.states.get(`${hook.id}|${pillId}`);
      if (s && (last === null || (s.last_sent_at ?? 0) > (last.last_sent_at ?? 0))) last = s;
    }
    if (!last || last.last_sent_at === null) return true;
    if (last.last_ok === 0) return last.retry_at === null || now >= last.retry_at;
    return now - last.last_sent_at >= hook.intervalMin * 60_000 + INTERVAL_GRACE_MS;
  }

  private takeCatchUp(hookId: string, now: number): boolean {
    const recent = (this.catchUpSends.get(hookId) ?? []).filter((t) => now - t < 60_000);
    const ok = recent.length < CATCH_UP_PER_MIN;
    if (ok) recent.push(now);
    this.catchUpSends.set(hookId, recent);
    return ok;
  }

  /** Remembers why a pill's reading was held back, for the status. */
  private note(hookId: string, pillId: string, plan: Plan): void {
    const key = `${hookId}|${pillId}`;
    const reason = plan.kind === 'skip' ? plan.reason : null;
    if ((this.skips.get(key) ?? null) === reason) return;
    if (reason === null) this.skips.delete(key);
    else this.skips.set(key, reason);
    this.changed(hookId);
  }

  private async deliver(hook: Webhook, items: Item[]): Promise<boolean> {
    const request = this.render(hook, items);
    const delivery = await this.send(hook.id, hook.batch ? null : items[0]!.pill.id, request, hook.timeoutSec, false);
    if (!this.hooks.has(hook.id)) return delivery.ok;
    let failures = 0;
    for (const { pill, reading } of items) {
      const prev = this.states.get(`${hook.id}|${pill.id}`);
      failures = delivery.ok ? 0 : (prev?.failures ?? 0) + 1;
      const backoff = Math.min(hook.intervalMin, BACKOFF_MIN[Math.min(failures, BACKOFF_MIN.length) - 1] ?? 60) * 60_000;
      this.saveState({
        webhook_id: hook.id,
        pill_id: pill.id,
        last_sent_at: delivery.at,
        last_reading_ts: delivery.ok ? reading.ts : (prev?.last_reading_ts ?? null),
        last_ok: delivery.ok ? 1 : 0,
        failures,
        retry_at: delivery.ok ? null : delivery.at + backoff,
        last_gravity: delivery.ok ? reading.gravity : (prev?.last_gravity ?? null),
        last_temp: delivery.ok ? reading.temperature : (prev?.last_temp ?? null),
        cursor_ts: prev?.cursor_ts ?? null,
      });
    }
    if (!delivery.ok && failures === 1) {
      this.log.warn(
        { webhook: hook.name, pills: items.map((i) => i.pill.id), error: delivery.error, status: delivery.status },
        'webhook failed',
      );
    }
    this.changed(hook.id);
    return delivery.ok;
  }

  private render(hook: WebhookInput, items: Item[]): RenderedRequest {
    const now = this.now();
    if (!hook.batch) return renderRequest(hook, this.context(hook, items[0]!, now));
    const batchCtx = buildBatchContext({
      count: items.length,
      now,
      intervalSec: Math.round(hook.intervalMin * 60),
      appVersion: this.deps.version,
      hubName: this.deps.hubName?.(),
    });
    return renderBatchRequest(
      hook,
      items.map((i) => this.context(hook, i, now)),
      batchCtx,
    );
  }

  /** For previews and tests: the chosen pill (or a sample), or every pill with a reading in batch mode. */
  private itemsFor(input: WebhookInput, pill: PillRef | null): Item[] {
    if (input.batch) {
      const items = this.pillsFor(input).flatMap((id) => {
        const p = this.deps.pills.get(id);
        const reading = p ? this.deps.pills.latest(id) : null;
        return p && reading ? [{ pill: p, reading }] : [];
      });
      if (items.length > 0) return items;
    }
    const reading = (pill && this.deps.pills.latest(pill.id)) ?? sampleReading(this.now());
    return [{ pill: pill ?? samplePill(), reading }];
  }

  private async send(
    webhookId: string,
    pillId: string | null,
    req: RenderedRequest,
    timeoutSec: number,
    test: boolean,
  ): Promise<WebhookDelivery> {
    const started = this.now();
    const headers = new Headers();
    headers.set('User-Agent', `RaptHooker/${this.deps.version}`);
    if (req.contentType) headers.set('Content-Type', req.contentType);
    let error: string | null = null;
    let status: number | null = null;
    let responseBody: string | null = null;
    try {
      for (const h of req.headers) headers.set(h.name, headerBytes(h.value));
      const res = await this.fetchImpl(req.url, {
        method: req.method,
        headers,
        body: req.body ?? undefined,
        signal: AbortSignal.timeout(Math.max(1, timeoutSec) * 1000),
        redirect: 'follow',
      });
      status = res.status;
      responseBody = (await res.text()).slice(0, RESPONSE_LOG_LIMIT);
      if (!res.ok) error = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      error = scrubUrls(e.name === 'TimeoutError' ? `No answer within ${timeoutSec} s` : (e.cause?.message ?? e.cause?.code ?? e.message));
    }
    const delivery: Omit<WebhookDelivery, 'id'> = {
      webhookId,
      pillId,
      at: started,
      ok: error === null,
      status,
      durationMs: Math.max(0, this.now() - started),
      method: req.method,
      url: req.url,
      requestBody: req.body === null ? null : req.body.slice(0, BODY_LOG_LIMIT),
      responseBody,
      error,
      test,
    };
    const id = this.hooks.has(webhookId) ? this.store.addDelivery(delivery) : 0;
    return { ...delivery, id };
  }

  private context(hook: WebhookInput, { pill, reading }: Item, now: number) {
    return buildContext({
      pill,
      reading,
      brew: this.deps.pills.get(pill.id) ? this.deps.brews.activeFor(pill.id) : null,
      gravityUnit: hook.gravityUnit,
      temperatureUnit: hook.temperatureUnit,
      intervalSec: Math.round(hook.intervalMin * 60),
      now,
      appVersion: this.deps.version,
      hubName: this.deps.hubName?.(),
    });
  }

  private insert(input: WebhookInput): Webhook {
    const now = this.now();
    const hook: Webhook = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, masked: false, status: emptyStatus() };
    this.hooks.set(hook.id, hook);
    this.store.saveWebhook(hook.id, input, now, now);
    this.changed(hook.id);
    return hook;
  }

  private statesFor(id: string): WebhookStateRow[] {
    return [...this.states.values()].filter((s) => s.webhook_id === id);
  }

  private saveState(s: WebhookStateRow): void {
    this.states.set(`${s.webhook_id}|${s.pill_id}`, s);
    this.store.saveWebhookState(s);
  }

  private withStatus(hook: Webhook): Webhook {
    const now = this.now();
    const last = this.store.listDeliveries(hook.id, 10).find((d) => !d.test) ?? null;
    const counts = this.store.deliveryCounts(hook.id, now - 86_400_000);
    const pills = this.pillsFor(hook).map((pillId) => {
      const key = `${hook.id}|${pillId}`;
      const s = this.states.get(key);
      const nextAt = s?.retry_at ?? (s?.last_sent_at != null ? s.last_sent_at + hook.intervalMin * 60_000 + INTERVAL_GRACE_MS : null);
      return {
        pillId,
        lastSentAt: s?.last_sent_at ?? null,
        lastOk: s ? s.last_ok === 1 : null,
        nextAt,
        skipped: this.skips.get(key) ?? null,
      };
    });
    const status: WebhookStatus = {
      lastAt: last?.at ?? null,
      lastOk: last ? last.ok : null,
      lastHttpStatus: last?.status ?? null,
      lastError: last?.error ?? null,
      sent24h: counts.sent,
      failed24h: counts.failed,
      pills,
    };
    return { ...hook, status };
  }

  private changed(id: string): void {
    const hook = this.hooks.get(id);
    if (hook) this.emit('status', id, this.withStatus(hook).status);
  }
}

/**
 * Whether a reading moved far enough from the last one sent (gravity in points, temperature in °C), or the
 * destination has heard nothing for `maxSilenceMin`. No thresholds: always.
 */
function changedEnough(hook: WebhookInput, s: WebhookStateRow, r: Reading, silentMs: number | null): boolean {
  const g = hook.minChangeGravity;
  const t = hook.minChangeTemp;
  if (g === null && t === null) return true;
  if (s.last_temp == null || (r.gravity !== null && s.last_gravity == null)) return true;
  if (hook.maxSilenceMin !== null && silentMs !== null && silentMs >= hook.maxSilenceMin * 60_000) return true;
  const eps = 1e-9;
  return (
    (g !== null && r.gravity !== null && s.last_gravity != null && Math.abs(r.gravity - s.last_gravity) * 1000 >= g - eps) ||
    (t !== null && Math.abs(r.temperature - s.last_temp) >= t - eps)
  );
}

function thresholdReason(hook: WebhookInput): string {
  const parts: string[] = [];
  if (hook.minChangeGravity !== null) parts.push(`the gravity moves ${hook.minChangeGravity} points`);
  if (hook.minChangeTemp !== null) {
    const f = hook.temperatureUnit === 'F';
    const delta = Math.round(hook.minChangeTemp * (f ? 1.8 : 1) * 100) / 100;
    parts.push(`the temperature ${delta} °${f ? 'F' : 'C'}`);
  }
  const silence = hook.maxSilenceMin !== null ? ` (or ${formatMinutes(hook.maxSilenceMin)} pass)` : '';
  return `Waiting until ${parts.join(' or ')} since the last send${silence}`;
}

function formatMinutes(min: number): string {
  if (min >= 1440 && min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'}`;
  if (min >= 60 && min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}

function emptyStatus(): WebhookStatus {
  return { lastAt: null, lastOk: null, lastHttpStatus: null, lastError: null, sent24h: 0, failed24h: 0, pills: [] };
}

function samplePill(): PillRef {
  return {
    id: 'sample',
    name: 'Sample Pill',
    address: '00:00:00:00:00:02',
    raptId: '00:00:00:00:00:00',
    info: { firmware: '20250319_000000_sample', deviceType: 'PillG1', payloadVersion: 2 },
  };
}
