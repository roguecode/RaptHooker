import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import {
  channelKindInfo,
  channelProblems,
  emailList,
  normalizeChannelConfig,
  type Channel,
  type ChannelInput,
  type ChannelKind,
} from '@rapthooker/shared';
import type { Store } from './db.js';
import type { Logger } from './log.js';
import { MASKED } from './settings.js';

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface Notification {
  title: string;
  message: string;
  /** A link back to the hub, when one is known (only absolute http(s) links are sent). */
  url?: string;
  /** Higher priority for alerts firing than for resolving. */
  priority: 'normal' | 'high';
  /** What it's about, for tags and colours. */
  kind?: 'fired' | 'resolved' | 'test';
}

/** The part of a nodemailer transport that's used. */
export interface MailTransport {
  sendMail(mail: { from: string; to: string[]; subject: string; text: string; priority: 'high' | 'normal' }): Promise<unknown>;
  close(): void;
}

export interface ChannelDeps {
  fetch?: typeof fetch;
  /** Makes the SMTP transport for email (tests pass a fake). */
  createTransport?: (options: SMTPTransport.Options) => MailTransport;
  now?: () => number;
  timeoutMs?: number;
}

interface ChannelRow {
  id: string;
  json: string;
  created_at: number;
  last_at: number | null;
  last_ok: number | null;
  last_error: string | null;
}

/** A failed send whose message is already readable (an HTTP status and what the service said). */
class SendError extends Error {}

const USER_AGENT = 'RaptHooker';
const ERROR_LIMIT = 300;
const COLORS = { fired: 0xfbbf24, resolved: 0x34d399, test: 0xa78bfa };
/** For connection errors that come without a message (Node tries IPv6 and IPv4 and reports both failing). */
const NETWORK_ERRORS: Record<string, string> = {
  ECONNREFUSED: 'the server refused the connection',
  ECONNRESET: 'the connection was dropped',
  ETIMEDOUT: 'the connection timed out',
  EHOSTUNREACH: "the server can't be reached",
  ENETUNREACH: "the network can't be reached",
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTTP header values must be plain ASCII; anything else is sent as an RFC 2047 encoded word (ntfy decodes these). */
const headerValue = (text: string): string =>
  /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text.replace(/[\r\n]+/g, ' '), 'utf8').toString('base64')}?=`;

const absoluteUrl = (url: string | undefined): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

/** The values that must never show up in errors or logs. */
function secretsOf(c: Pick<ChannelInput, 'kind' | 'config'>): string[] {
  return channelKindInfo(c.kind)
    .fields.filter((f) => f.secret)
    .map((f) => c.config[f.key] ?? '')
    .filter((v) => v.length >= 3);
}

/** Takes secrets and links out of an error message. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join('••••');
  }
  return out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '(link)');
}

/** What a service said went wrong, from its error response. */
function detailOf(body: string): string {
  let detail = '';
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    if (typeof j.description === 'string') detail = j.description;
    else if (Array.isArray(j.errors)) detail = j.errors.map(String).join(', ');
    else if (typeof j.error === 'string') detail = j.error;
    else if (typeof j.message === 'string') detail = j.message;
  } catch {
    detail = /<[a-z!]/i.test(body) ? '' : body;
  }
  return detail.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** "HTTP 401: Unauthorized", with the service's own explanation when it gives one. */
function httpError(status: number, statusText: string, body: string): string {
  const detail = detailOf(body);
  return `HTTP ${status}${detail ? `: ${detail}` : statusText ? ` ${statusText}` : ''}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Hides everything but the harmless settings (and the details of errors) from people who aren't the owner. */
export function maskChannel(c: Channel): Channel {
  const shown = new Set(
    channelKindInfo(c.kind)
      .fields.filter((f) => f.public)
      .map((f) => f.key),
  );
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.config)) config[k] = shown.has(k) || !v ? v : MASKED;
  const lastError = c.lastError === null ? null : (/^HTTP \d{3}/.exec(c.lastError)?.[0] ?? 'Send failed');
  return { ...c, config, masked: true, lastError };
}

/**
 * Notification channels for alerts: ntfy, Pushover, Telegram, Discord and email. Each send's result is kept on the
 * channel. Emits 'channel' (Channel) when one changes and 'removed' (id) when one is deleted.
 */
export class ChannelService extends EventEmitter {
  private channels = new Map<string, Channel>();
  private readonly fetchImpl: typeof fetch;
  private readonly makeTransport: (options: SMTPTransport.Options) => MailTransport;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    deps: ChannelDeps = {},
  ) {
    super();
    this.fetchImpl = deps.fetch ?? fetch;
    this.makeTransport = deps.createTransport ?? ((options) => nodemailer.createTransport(options));
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  load(): void {
    this.channels.clear();
    const rows = this.store.db
      .prepare('SELECT id, json, created_at, last_at, last_ok, last_error FROM channels ORDER BY created_at')
      .all() as unknown as ChannelRow[];
    for (const row of rows) {
      try {
        const input = JSON.parse(row.json) as ChannelInput;
        this.channels.set(row.id, {
          name: input.name,
          kind: input.kind,
          enabled: input.enabled,
          config: normalizeChannelConfig(input.kind, input.config ?? {}),
          id: row.id,
          createdAt: row.created_at,
          masked: false,
          lastAt: row.last_at,
          lastOk: row.last_ok === null ? null : row.last_ok === 1,
          lastError: row.last_error,
        });
      } catch (err) {
        this.log.error({ id: row.id, err: (err as Error).message }, 'skipped a notification channel that could not be read');
      }
    }
  }

  list(forOwner = true): Channel[] {
    return [...this.channels.values()].map((c) => (forOwner ? copy(c) : maskChannel(c)));
  }

  get(id: string, forOwner = true): Channel | null {
    const c = this.channels.get(id);
    if (!c) return null;
    return forOwner ? copy(c) : maskChannel(c);
  }

  create(input: ChannelInput): Channel {
    const clean = this.prepare(input, null);
    const channel: Channel = {
      ...clean,
      id: randomBytes(8).toString('hex'),
      createdAt: this.now(),
      masked: false,
      lastAt: null,
      lastOk: null,
      lastError: null,
    };
    this.store.db
      .prepare('INSERT INTO channels (id, json, created_at) VALUES (?, ?, ?)')
      .run(channel.id, JSON.stringify(clean), channel.createdAt);
    this.channels.set(channel.id, channel);
    this.emit('channel', copy(channel));
    return copy(channel);
  }

  update(id: string, input: ChannelInput): Channel {
    const old = this.channels.get(id);
    if (!old) throw new ChannelError('Unknown notification channel', 404);
    const clean = this.prepare(input, old);
    const channel: Channel = { ...old, ...clean };
    this.store.db.prepare('UPDATE channels SET json = ? WHERE id = ?').run(JSON.stringify(clean), id);
    this.channels.set(id, channel);
    this.emit('channel', copy(channel));
    return copy(channel);
  }

  delete(id: string): void {
    if (!this.channels.delete(id)) throw new ChannelError('Unknown notification channel', 404);
    this.store.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    this.emit('removed', id);
  }

  /**
   * Sends to the given channels ('all': every enabled channel), all at once. Unknown and switched-off channels are
   * skipped. Never throws; failures are logged and kept on the channel.
   */
  async send(channelIds: string[] | 'all', n: Notification): Promise<void> {
    try {
      const targets =
        channelIds === 'all'
          ? [...this.channels.values()]
          : [...new Set(channelIds)].map((id) => this.channels.get(id)).filter((c): c is Channel => c !== undefined);
      await Promise.all(targets.filter((c) => c.enabled).map((c) => this.sendOne(c, n)));
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'sending notifications failed');
    }
  }

  /** Sends a test notification through one channel's settings (saved or not); rejects with a readable error. */
  async test(input: ChannelInput, id: string | null, hubName = 'RaptHooker'): Promise<void> {
    const saved = id ? (this.channels.get(id) ?? null) : null;
    const config = normalizeChannelConfig(input.kind, this.unmask(input, saved));
    const problems = channelProblems({ kind: input.kind, config });
    if (problems.length) throw new ChannelError(`${problems.join('. ')}.`);
    const channel = { kind: input.kind, config };
    try {
      await this.deliver(channel, {
        title: hubName,
        message: `RaptHooker test: notifications from ${hubName} work`,
        priority: 'normal',
        kind: 'test',
      });
    } catch (err) {
      throw new ChannelError(this.readable(err, channel));
    }
  }

  private async sendOne(c: Channel, n: Notification): Promise<void> {
    let error: string | null = null;
    try {
      await this.deliver(c, n);
    } catch (err) {
      error = this.readable(err, c);
      this.log.warn({ channel: c.name, kind: c.kind, err: error }, 'notification failed');
    }
    try {
      this.recordResult(c.id, error);
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'could not save the notification result');
    }
  }

  private recordResult(id: string, error: string | null): void {
    const at = this.now();
    this.store.db
      .prepare('UPDATE channels SET last_at = ?, last_ok = ?, last_error = ? WHERE id = ?')
      .run(at, error === null ? 1 : 0, error, id);
    const c = this.channels.get(id);
    if (!c) return;
    const next: Channel = { ...c, lastAt: at, lastOk: error === null, lastError: error };
    this.channels.set(id, next);
    this.emit('channel', copy(next));
  }

  /** The settings to save: masked values kept from the saved channel, tidied, and checked when it's switched on. */
  private prepare(input: ChannelInput, saved: Channel | null): ChannelInput {
    const clean: ChannelInput = {
      name: input.name.trim(),
      kind: input.kind,
      enabled: input.enabled,
      config: normalizeChannelConfig(input.kind, this.unmask(input, saved)),
    };
    if (clean.enabled) {
      const problems = channelProblems(clean);
      if (problems.length) throw new ChannelError(`${problems.join('. ')}. (Or save it switched off for now.)`);
    }
    return clean;
  }

  /** A masked value sent back means "keep the saved one". */
  private unmask(input: ChannelInput, saved: Channel | null): Record<string, string> {
    const out: Record<string, string> = { ...input.config };
    for (const [key, value] of Object.entries(out)) {
      if (value !== MASKED) continue;
      const keep = saved && saved.kind === input.kind ? saved.config[key] : undefined;
      if (keep === undefined) {
        const label = channelKindInfo(input.kind).fields.find((f) => f.key === key)?.label ?? key;
        throw new ChannelError(`Type the ${label} again`);
      }
      out[key] = keep;
    }
    return out;
  }

  private readable(err: unknown, c: Pick<ChannelInput, 'kind' | 'config'>): string {
    const e = err as (Error & { cause?: { code?: string; message?: string } }) | undefined;
    let text: string;
    if (e instanceof SendError) text = e.message;
    else if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
      text = `No answer within ${Math.max(1, Math.round(this.timeoutMs / 1000))} s`;
    else if (e?.cause && (e.cause.message || e.cause.code)) {
      const code = e.cause.code ?? '';
      text = `Couldn't connect: ${e.cause.message || NETWORK_ERRORS[code] || code}`;
    } else text = e?.message || String(err);
    return clip(scrubSecrets(text.replace(/\s+/g, ' ').trim(), secretsOf(c)), ERROR_LIMIT);
  }

  private async post(
    url: string,
    opts: { headers?: Record<string, string>; body?: string | URLSearchParams; json?: unknown },
  ): Promise<string> {
    const headers = new Headers({ 'User-Agent': USER_AGENT, ...opts.headers });
    let body = opts.body;
    if (opts.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(opts.json);
    }
    const res = await this.fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new SendError(httpError(res.status, res.statusText, text));
    return text;
  }

  private async deliver(c: { kind: ChannelKind; config: Record<string, string> }, n: Notification): Promise<void> {
    const cfg = c.config;
    const url = absoluteUrl(n.url);
    const kind = n.kind ?? (n.priority === 'high' ? 'fired' : 'resolved');
    switch (c.kind) {
      case 'ntfy': {
        // The X- names: proxies in front of ntfy can set a plain "Priority" header of their own (HTTP priorities).
        const headers: Record<string, string> = {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Title': headerValue(clip(n.title, 250)),
          'X-Priority': n.priority === 'high' ? 'high' : 'default',
          'X-Tags': { fired: 'warning', resolved: 'white_check_mark', test: 'beer' }[kind],
        };
        if (url) headers['X-Click'] = url;
        if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
        else if (cfg.username) headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64')}`;
        const server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
        await this.post(`${server}/${encodeURIComponent(cfg.topic ?? '')}`, { headers, body: clip(n.message, 4000) });
        return;
      }
      case 'pushover': {
        const form = new URLSearchParams({
          token: cfg.token ?? '',
          user: cfg.user ?? '',
          title: clip(n.title, 250),
          message: clip(n.message, 1024),
          priority: n.priority === 'high' ? '1' : '0',
        });
        if (cfg.device) form.set('device', cfg.device);
        if (url) {
          form.set('url', url);
          form.set('url_title', 'Open RaptHooker');
        }
        const text = await this.post('https://api.pushover.net/1/messages.json', { body: form });
        let status: unknown = 1;
        try {
          status = (JSON.parse(text) as { status?: unknown }).status;
        } catch {
          // An empty or non-JSON 200 still counts as sent.
        }
        if (status !== 1) throw new SendError(detailOf(text) || 'Pushover turned the message down');
        return;
      }
      case 'telegram': {
        let text = `<b>${escapeHtml(clip(n.title, 200))}</b>\n${escapeHtml(clip(n.message, 3500))}`;
        if (url) text += `\n<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">Open RaptHooker</a>`;
        await this.post(`https://api.telegram.org/bot${cfg.botToken ?? ''}/sendMessage`, {
          json: { chat_id: cfg.chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        });
        return;
      }
      case 'discord': {
        const embed: Record<string, unknown> = {
          title: clip(n.title, 256),
          description: clip(n.message, 4000),
          color: COLORS[kind],
          timestamp: new Date(this.now()).toISOString(),
        };
        if (url) embed.url = url;
        await this.post(cfg.url ?? '', { json: { username: 'RaptHooker', embeds: [embed], allowed_mentions: { parse: [] } } });
        return;
      }
      case 'email': {
        const security = cfg.security || 'starttls';
        const transport = this.makeTransport({
          host: cfg.host,
          port: Number(cfg.port) || 587,
          secure: security === 'tls',
          requireTLS: security === 'starttls',
          ignoreTLS: security === 'none',
          auth: cfg.username ? { user: cfg.username, pass: cfg.password ?? '' } : undefined,
          connectionTimeout: this.timeoutMs,
          greetingTimeout: this.timeoutMs,
          socketTimeout: this.timeoutMs,
        });
        try {
          await withTimeout(
            transport.sendMail({
              from: cfg.from ?? '',
              to: emailList(cfg.to ?? ''),
              subject: clip(n.title, 200),
              text: `${n.message}\n${url ? `\n${url}\n` : ''}\n-- \nSent by RaptHooker\n`,
              priority: n.priority === 'high' ? 'high' : 'normal',
            }),
            this.timeoutMs,
          );
        } finally {
          try {
            transport.close();
          } catch {
            // Already closed.
          }
        }
        return;
      }
      default:
        throw new SendError(`Unknown kind of channel: ${String(c.kind)}`);
    }
  }
}

function copy(c: Channel): Channel {
  return { ...c, config: { ...c.config } };
}
