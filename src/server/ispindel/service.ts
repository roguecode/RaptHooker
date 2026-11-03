import { EventEmitter } from 'node:events';
import {
  ISPINDEL_PATH,
  chipIdFromBssid,
  isIspindelHotspot,
  pillIdFromAddress,
  type HubAddress,
  type IspindelHotspot,
  type IspindelInfo,
  type IspindelPost,
  type IspindelServer,
  type IspindelSetupInput,
  type IspindelSetupProgress,
  type IspindelWritten,
} from '@rapthooker/shared';
import type { Store } from '../db.js';
import type { Logger } from '../log.js';
import { PillError, type PillService } from '../pills.js';
import type { WifiController } from '../screens/wifi/types.js';
import type { TokenService } from '../tokens.js';
import { decodeIspindel } from './decode.js';
import { IspindelSetup } from './setup.js';

export class IspindelError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface IspindelServiceDeps {
  store: Store;
  tokens: TokenService;
  pills: PillService;
  /** The hub's Wi-Fi (shared with screens' set-up). */
  wifi: WifiController;
  /** The hub's addresses on its network. */
  addresses: () => Promise<HubAddress[]>;
  /** A screen is being set up: the Wi-Fi is busy. */
  screensBusy: () => boolean;
  log: Logger;
  now?: () => number;
  /** Shorter waits (tests). */
  fast?: boolean;
}

/** The token the hub made for iSpindels, kept so it can be shown again (it only lets them post readings). */
const TOKEN_KEY = 'ispindelToken';
/** iSpindels set up by the hub that haven't sent a reading yet, kept across restarts (an update, say). */
const PENDING_KEY = 'ispindelPending';
/** While someone has the iSpindel tab open, the hub looks for hotspots this often… */
const WATCHED_SCAN_MS = 15_000;
/** …for this long after they last asked. */
const WATCH_MS = 90_000;
/** Otherwise it looks at the networks the Wi-Fi has seen anyway, this often. */
const BACKGROUND_SCAN_MS = 60_000;
/** An iSpindel set up by the hub is added when its first reading comes, for this long. */
const PENDING_MS = 2 * 3_600_000;
/**
 * How a set-up ended is kept for a page that missed it (the hub may have been off the network), until a page has shown
 * it or for this long, so the tab is ready to set up another after that.
 */
const ENDED_KEEP_MS = 15 * 60_000;

interface Pending {
  chipId: string | null;
  name: string;
  until: number;
  resolve: ((id: string | null) => void) | null;
}

/**
 * iSpindels: the readings they post (see routes/ispindel.ts), the token they send, finding ones in setup mode (their
 * open "iSpindel…" hotspots, from the hub's Wi-Fi scans) and setting them up. Emits 'hotspots' (IspindelHotspot[],
 * scannedAt) and 'setup' (IspindelSetupProgress).
 */
export class IspindelService extends EventEmitter {
  private found: IspindelHotspot[] = [];
  private scannedAt: number | null = null;
  private lastFresh = 0;
  private scanning: Promise<IspindelHotspot[]> | null = null;
  private watchUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private job: IspindelSetup | null = null;
  private lastSetup: IspindelSetupProgress | null = null;
  private pending: Pending[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: IspindelServiceDeps) {
    super();
    this.now = deps.now ?? Date.now;
    try {
      const saved = JSON.parse(deps.store.getMeta(PENDING_KEY) ?? '[]') as Omit<Pending, 'resolve'>[];
      const now = this.now();
      this.pending = saved
        .filter((p) => typeof p.name === 'string' && typeof p.until === 'number' && p.until > now)
        .map((p) => ({ chipId: typeof p.chipId === 'string' ? p.chipId : null, name: p.name, until: p.until, resolve: null }));
    } catch {}
  }

  private savePending(): void {
    const keep = this.pending.map(({ chipId, name, until }) => ({ chipId, name, until }));
    if (keep.length) this.deps.store.setMeta(PENDING_KEY, JSON.stringify(keep));
    else this.deps.store.deleteMeta(PENDING_KEY);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const p of this.pending) p.resolve?.(null);
  }

  // ---- readings

  /** Whether `token` is the iSpindel token. */
  verify(token: string | null | undefined): boolean {
    return !!token && this.deps.tokens.verify(token, 'ispindel') !== null;
  }

  /** A post from an iSpindel (its token already checked). */
  ingest(
    post: IspindelPost,
    at: number,
    mono: number,
  ): { ok: true; status: 'recorded' | 'nearby' | 'ignored' } | { ok: false; reason: string } {
    const decoded = decodeIspindel(post, at);
    if (!decoded.ok) return decoded;
    let status = this.deps.pills.handleIspindel(decoded, mono);
    if (status !== 'recorded' && this.claim(decoded.address, decoded.name)) status = 'recorded';
    return { ok: true, status };
  }

  /** Adds an iSpindel the hub set up, when it's the one a set-up is waiting for. */
  private claim(address: string, name: string | null): boolean {
    const now = this.now();
    if (this.pending.some((p) => p.until <= now)) {
      this.pending = this.pending.filter((p) => p.until > now);
      this.savePending();
    }
    const chip = address.slice(address.indexOf(':') + 1);
    const i = this.pending.findIndex((p) => (p.chipId !== null && p.chipId === chip) || (name !== null && p.name === name));
    if (i === -1) return false;
    const [p] = this.pending.splice(i, 1);
    this.savePending();
    let id: string;
    try {
      id = this.deps.pills.adopt(address, { name: p!.name }).id;
    } catch (err) {
      if (!(err instanceof PillError) || err.statusCode !== 409) {
        this.deps.log.warn({ err: (err as Error).message, address }, "couldn't add an iSpindel that was set up");
        return false;
      }
      id = pillIdFromAddress(address);
    }
    this.deps.log.info({ address, id }, 'added an iSpindel that was set up from the hub');
    p!.resolve?.(id);
    return true;
  }

  private firstReading(written: IspindelWritten, chipId: string | null, ms: number): Promise<string | null> {
    return new Promise((resolve) => {
      const entry: Pending = { chipId, name: written.name, until: this.now() + PENDING_MS, resolve: null };
      const timer = setTimeout(() => {
        entry.resolve = null;
        resolve(null);
      }, ms);
      timer.unref?.();
      entry.resolve = (id) => {
        clearTimeout(timer);
        entry.resolve = null;
        resolve(id);
      };
      this.pending = [...this.pending.filter((p) => !(chipId !== null && p.chipId === chipId)), entry];
      this.savePending();
    });
  }

  // ---- the token and where to post

  /** The iSpindel token, made the first time it's needed (and again if it was deleted under Settings → API tokens). */
  token(): string {
    try {
      const saved = JSON.parse(this.deps.store.getMeta(TOKEN_KEY) ?? 'null') as { id: string; token: string } | null;
      if (saved && this.deps.tokens.has(saved.id)) return saved.token;
    } catch {}
    const created = this.deps.tokens.create('iSpindels', 'ispindel', this.now());
    this.deps.store.setMeta(TOKEN_KEY, JSON.stringify({ id: created.id, token: created.token }));
    this.deps.log.info('made a token for iSpindels');
    return created.token;
  }

  /** Where iSpindels post: the hub's own IPv4 address (they can't look up .local names), port and path. */
  async server(): Promise<IspindelServer> {
    const list = await this.deps.addresses().catch(() => [] as HubAddress[]);
    const hosts: string[] = [];
    let port = 80;
    for (const a of list) {
      if (a.kind !== 'lan') continue;
      try {
        const u = new URL(a.url);
        if (u.hostname.startsWith('[')) continue;
        hosts.push(u.hostname);
        port = u.port ? Number(u.port) : 80;
      } catch {}
    }
    return { host: hosts[0] ?? null, hosts, port, path: ISPINDEL_PATH };
  }

  // ---- finding iSpindels in setup mode

  hotspots(): IspindelHotspot[] {
    return this.found.map((h) => ({ ...h }));
  }

  /** Someone is looking: scan properly every few seconds for a while. */
  watch(): void {
    this.watchUntil = this.now() + WATCH_MS;
    if (this.now() - this.lastFresh > 10_000) void this.scan(true);
  }

  private async tick(): Promise<void> {
    if (this.job || this.deps.screensBusy()) return;
    const now = this.now();
    if (now < this.watchUntil && now - this.lastFresh >= WATCHED_SCAN_MS) await this.scan(true);
    else if (now - (this.scannedAt ?? 0) >= BACKGROUND_SCAN_MS) await this.scan(false);
  }

  /** Looks for iSpindel hotspots: a fresh scan, or what the Wi-Fi has seen lately. */
  scan(fresh: boolean): Promise<IspindelHotspot[]> {
    // Not while the hub is away on a hotspot, setting something up.
    if (this.job || this.deps.screensBusy()) return Promise.resolve(this.hotspots());
    this.scanning ??= (async () => {
      try {
        const nets = await this.deps.wifi.scan({ cached: !fresh });
        const at = this.now();
        if (fresh) this.lastFresh = at;
        const list = nets
          .filter((n) => isIspindelHotspot(n.ssid, n.secure))
          .map((n): IspindelHotspot => ({
            ssid: n.ssid,
            bssid: n.bssid,
            chipId: chipIdFromBssid(n.bssid),
            signal: n.signal,
            channel: n.channel,
            seenAt: at,
          }));
        const changed = JSON.stringify(list.map((h) => [h.ssid, h.bssid])) !== JSON.stringify(this.found.map((h) => [h.ssid, h.bssid]));
        for (const h of list)
          if (!this.found.some((f) => f.bssid === h.bssid))
            this.deps.log.info({ ssid: h.ssid, chipId: h.chipId }, 'found an iSpindel in setup mode');
        this.found = list;
        this.scannedAt = at;
        if (changed || fresh) this.emit('hotspots', this.hotspots(), at);
      } catch (err) {
        this.deps.log.debug({ err: (err as Error).message }, 'looking for iSpindels failed');
      } finally {
        this.scanning = null;
      }
      return this.hotspots();
    })();
    return this.scanning;
  }

  // ---- setting one up

  setupProgress(): IspindelSetupProgress | null {
    if (this.job) return this.job.snapshot();
    if (this.lastSetup && this.now() - this.lastSetup.updatedAt > ENDED_KEEP_MS) this.lastSetup = null;
    return this.lastSetup;
  }

  /** A page has shown how this set-up ended: it isn't offered again. */
  forget(id: string): void {
    if (this.lastSetup?.id === id) this.lastSetup = null;
  }

  /** What the Add device dialog needs. Viewers don't get the token, the hub's network name or how a set-up is going. */
  async info(owner: boolean): Promise<IspindelInfo> {
    const wifi = await this.deps.wifi.status();
    return {
      token: owner ? this.token() : null,
      server: await this.server(),
      wifi: owner ? wifi : { ...wifi, ssid: null },
      hotspots: this.hotspots(),
      scannedAt: this.scannedAt,
      setup: owner ? this.setupProgress() : null,
    };
  }

  /** Starts setting an iSpindel up; follow it with setupProgress or the 'setup' events. */
  async startSetup(input: IspindelSetupInput): Promise<IspindelSetupProgress> {
    if (this.job) throw new IspindelError('An iSpindel is already being set up', 409);
    if (this.deps.screensBusy()) throw new IspindelError("The hub's Wi-Fi is busy setting up a screen: try again when it's done", 409);
    // Worked out while the hub is still on its network.
    const server = await this.server();
    const token = this.token();
    const chipId = this.found.find((h) => h.ssid === input.hotspot)?.chipId ?? null;
    if (this.job) throw new IspindelError('An iSpindel is already being set up', 409);
    const job = new IspindelSetup(input, {
      wifi: this.deps.wifi,
      server,
      token,
      chipId,
      firstReading: (written, chip, ms) => this.firstReading(written, chip, ms),
      log: this.deps.log,
      now: this.now,
      fast: this.deps.fast,
    });
    this.job = job;
    job.on('progress', (p: IspindelSetupProgress) => {
      if (p.state !== 'running' && this.job === job) {
        this.lastSetup = p;
        this.job = null;
        // It's left setup mode (or is still in it, if that failed): look again.
        void this.scan(true);
      }
      this.emit('setup', p);
    });
    void job.run().catch((err: Error) => this.deps.log.error({ err: err.message }, 'iSpindel set-up crashed'));
    return job.snapshot();
  }

  /** Whether an iSpindel is being set up (the Wi-Fi is busy). */
  busy(): boolean {
    return this.job !== null;
  }
}
