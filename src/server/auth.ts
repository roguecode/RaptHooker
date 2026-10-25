import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ApiToken, Session, TokenScope } from '@rapthooker/shared';
import type { Config } from './config.js';
import { bearer } from './tokens.js';

export const PIN_COOKIE = 'rapthooker_pin';
const PIN_TTL_MS = 90 * 24 * 3_600_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60_000;
const PIN_KEY = 'ownerPinHash';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when a browser made this request on behalf of another website. Owner access through Tailscale comes from the
 * network, not a cookie, so without this any page open on a tailnet device could make changes (or open the live
 * socket) as the owner. Reading is left alone; scripts and devices that send no Origin are unaffected.
 */
export function crossSiteRequest(req: FastifyRequest): boolean {
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
  if (SAFE_METHODS.has(req.method) && !upgrade) return false;
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin' || site === 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return site === 'cross-site';
  try {
    return new URL(origin).host.toLowerCase() !== String(req.headers.host ?? '').toLowerCase();
  } catch {
    // "null" (sandboxed pages, file://) or junk.
    return true;
  }
}

export interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export class PinError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** A request with an API token it can't use: 401 for an unknown token, 403 for the wrong kind of request. */
export class TokenError extends PinError {}

export interface TokenVerifier {
  verify(token: string, scope: TokenScope): ApiToken | null;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Where relays post adverts (the only thing a relay token is for). */
const RELAY_PATH = '/api/relay';

/**
 * A request carrying `Authorization: Bearer <token>`: a read token is a viewer that can only read, a relay token may
 * only post adverts (the relay route checks it again). Anything else is refused rather than quietly treated as a
 * guest, so a script with a wrong or deleted token finds out.
 */
function tokenSession(tokens: TokenVerifier, req: FastifyRequest, token: string): Pick<Session, 'role' | 'user' | 'via'> {
  const method = req.method.toUpperCase();
  const path = req.url.split('?')[0] ?? '';
  const read = tokens.verify(token, 'read');
  if (read) {
    if (!READ_METHODS.has(method)) throw new TokenError('API tokens can only read. Sign in as the owner to make changes.', 403);
    return { role: 'viewer', user: `token:${read.name}`, via: 'token' };
  }
  const relay = tokens.verify(token, 'relay');
  if (relay) {
    if (method === 'POST' && (path === RELAY_PATH || path.startsWith(`${RELAY_PATH}/`))) {
      return { role: 'viewer', user: `relay:${relay.name}`, via: 'token' };
    }
    throw new TokenError(`This is a relay token: it can only post Bluetooth adverts to ${RELAY_PATH}`, 403);
  }
  throw new TokenError('Unknown or deleted API token', 401);
}

/**
 * Viewing is open to anyone who can reach the hub; changes need the owner. The owner is someone signed in with the
 * PIN (created in the app on first visit, stored as a scrypt hash), or a Tailscale user coming through
 * `tailscale serve` (which proxies from loopback and adds Tailscale-User-* headers, so they're only trusted there).
 * Scripts can use a 'read' API token (a viewer that can only read); relays use a 'relay' token for posting adverts.
 */
export class Auth {
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly cfg: Config['auth'],
    private readonly store: MetaStore,
    private readonly tokens?: TokenVerifier,
  ) {}

  session(req: FastifyRequest): Session {
    const remote = req.socket.remoteAddress ?? '';
    const loopback = LOOPBACK.has(remote);
    const host = String(req.headers.host ?? '');
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '');
    const secure = req.protocol === 'https' || (loopback && (forwardedProto === 'https' || host.endsWith('.ts.net')));
    const pinSet = this.pinSet();

    const token = this.tokens ? bearer(req.headers.authorization) : null;
    if (this.tokens && token !== null) return { ...tokenSession(this.tokens, req, token), secure, pinSet };

    const tsLogin = loopback ? req.headers['tailscale-user-login'] : undefined;
    if (typeof tsLogin === 'string' && tsLogin) {
      const allowed = this.cfg.allowedTailscaleUsers;
      const owner = allowed.length === 0 || allowed.some((u) => u.toLowerCase() === tsLogin.toLowerCase());
      return { role: owner ? 'owner' : 'viewer', user: tsLogin, via: 'tailscale', secure, pinSet };
    }
    if (this.hasValidPinCookie(req)) return { role: 'owner', user: 'pin', via: 'pin', secure, pinSet };
    if (loopback && this.cfg.trustLocalhost && !req.headers['x-forwarded-for']) {
      return { role: 'owner', user: 'localhost', via: 'localhost', secure, pinSet };
    }
    return { role: 'viewer', user: 'guest', via: 'lan', secure, pinSet };
  }

  pinSet(): boolean {
    return this.store.getMeta(PIN_KEY) !== null;
  }

  /** Creates or replaces the owner PIN and returns a sign-in cookie value. */
  setPin(pin: string, now = Date.now()): string {
    if (!/^\S{4,32}$/.test(pin)) throw new PinError('The PIN needs 4 to 32 characters, without spaces');
    const salt = randomBytes(16);
    const hash = scryptSync(pin, salt, 32);
    this.store.setMeta(PIN_KEY, `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`);
    return this.cookieValue(now);
  }

  checkPin(ip: string, pin: string, now = Date.now()): { ok: true; cookie: string } | { ok: false; error: string } {
    if (!this.pinSet()) return { ok: false, error: 'No owner PIN yet: create one first' };
    const f = this.failures.get(ip);
    if (f && f.count >= MAX_FAILURES && now < f.until) {
      return { ok: false, error: `Too many attempts. Try again in ${Math.ceil((f.until - now) / 60_000)} min` };
    }
    if (this.pinMatches(pin)) {
      this.failures.delete(ip);
      return { ok: true, cookie: this.cookieValue(now) };
    }
    const count = f && now < f.until ? f.count + 1 : 1;
    this.failures.set(ip, { count, until: now + LOCKOUT_MS });
    return { ok: false, error: 'Wrong PIN' };
  }

  cookieMaxAgeSec(): number {
    return PIN_TTL_MS / 1000;
  }

  private pinMatches(pin: string): boolean {
    const stored = this.store.getMeta(PIN_KEY);
    if (!stored) return false;
    const [, saltHex, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex ?? '', 'hex');
    const actual = scryptSync(pin, Buffer.from(saltHex ?? '', 'hex'), expected.length || 32);
    return expected.length > 0 && timingSafeEqual(actual, expected);
  }

  private cookieValue(now: number): string {
    return `ok.${now}.${this.fingerprint()}`;
  }

  private hasValidPinCookie(req: FastifyRequest): boolean {
    if (!this.pinSet()) return false;
    const raw = req.cookies[PIN_COOKIE];
    if (!raw) return false;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return false;
    const [tag, issued, fp] = unsigned.value.split('.');
    return tag === 'ok' && fp === this.fingerprint() && Number.isFinite(Number(issued)) && Date.now() - Number(issued) < PIN_TTL_MS;
  }

  /** Changing the PIN signs everyone out. */
  private fingerprint(): string {
    return createHash('sha256')
      .update(this.store.getMeta(PIN_KEY) ?? '')
      .digest('hex')
      .slice(0, 12);
  }
}
