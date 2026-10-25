import { createHash, randomBytes } from 'node:crypto';
import type { ApiToken, ApiTokenCreated, TokenScope } from '@rapthooker/shared';
import type { Store } from './db.js';

interface TokenRow {
  id: string;
  name: string;
  scope: string;
  hint: string;
  created_at: number;
  last_used_at: number | null;
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * API tokens: 'read' tokens let scripts use the read-only API, 'relay' tokens let a Bluetooth relay (an ESP32) post
 * adverts. Only a hash is stored; the token itself is shown once.
 */
export class TokenService {
  /** last_used_at is written at most this often per token. */
  private readonly touched = new Map<string, number>();

  constructor(private readonly store: Store) {}

  list(): ApiToken[] {
    const rows = this.store.db
      .prepare('SELECT id, name, scope, hint, created_at, last_used_at FROM api_tokens ORDER BY created_at')
      .all() as unknown as TokenRow[];
    return rows.map(toToken);
  }

  create(name: string, scope: TokenScope, now = Date.now()): ApiTokenCreated {
    const token = `rh_${scope}_${randomBytes(24).toString('base64url')}`;
    const id = randomBytes(8).toString('hex');
    const hint = token.slice(-4);
    this.store.db
      .prepare('INSERT INTO api_tokens (id, name, scope, hash, hint, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, scope, hash(token), hint, now);
    return { id, name, scope, hint, createdAt: now, lastUsedAt: null, token };
  }

  remove(id: string): boolean {
    return Number(this.store.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes) > 0;
  }

  /** The token's details if it exists and has the scope, else null. */
  verify(token: string, scope: TokenScope, now = Date.now()): ApiToken | null {
    if (!token.startsWith('rh_')) return null;
    const row = this.store.db
      .prepare('SELECT id, name, scope, hint, created_at, last_used_at FROM api_tokens WHERE hash = ?')
      .get(hash(token)) as unknown as TokenRow | undefined;
    if (!row || row.scope !== scope) return null;
    if (now - (this.touched.get(row.id) ?? 0) > 60_000) {
      this.touched.set(row.id, now);
      this.store.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
      row.last_used_at = now;
    }
    return toToken(row);
  }
}

/** The bearer token from an Authorization header, if any. */
export function bearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)$/i.exec(value ?? '');
  return m ? m[1]! : null;
}

function toToken(r: TokenRow): ApiToken {
  return { id: r.id, name: r.name, scope: r.scope as TokenScope, hint: r.hint, createdAt: r.created_at, lastUsedAt: r.last_used_at };
}
