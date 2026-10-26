import { existsSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../db.js';

const DAY = 86_400_000;

/** Compact when more than this share of the database file is unused pages. */
export const COMPACT_FREE_RATIO = 0.2;
/** Bigger databases take too long to compact while the hub waits; they're left alone. */
export const COMPACT_MAX_BYTES = 1024 ** 3;
/** Below this much free disk, old logs are trimmed to keep recording. */
export const EMERGENCY_FREE_BYTES = 100 * 1024 ** 2;
/** What the emergency trim keeps: webhook delivery logs and alert history from the last week. Readings are never touched. */
export const EMERGENCY_KEEP_MS = 7 * DAY;

const fileSize = (path: string) => {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
};

/** The database file plus its write-ahead log. */
export const dbFileBytes = (path: string): number => fileSize(path) + fileSize(`${path}-wal`);

export interface DbPages {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
}

export function dbPages(db: DatabaseSync): DbPages {
  const one = (pragma: string) => Number(Object.values(db.prepare(`PRAGMA ${pragma}`).get() ?? {})[0] ?? 0);
  return { pageSize: one('page_size'), pageCount: one('page_count'), freelistCount: one('freelist_count') };
}

export interface CompactionPlan {
  run: boolean;
  /** Why (not), for the log. */
  reason: string;
  /** Share of the file that is unused pages. */
  freeRatio: number;
}

/** Whether to VACUUM: plenty of unused pages, a database that compacts quickly, and room on the disk for the copy. */
export function planCompaction(pages: DbPages, dbBytes: number, freeDiskBytes: number | null): CompactionPlan {
  const freeRatio = pages.pageCount > 0 ? pages.freelistCount / pages.pageCount : 0;
  const pct = `${Math.round(freeRatio * 100)}%`;
  if (freeRatio <= COMPACT_FREE_RATIO) return { run: false, reason: `only ${pct} of the database is unused space`, freeRatio };
  if (dbBytes > COMPACT_MAX_BYTES) return { run: false, reason: 'the database is too big to compact automatically', freeRatio };
  // VACUUM writes a full copy, and the write-ahead log grows to about the same size again before it's checkpointed.
  if (freeDiskBytes === null || freeDiskBytes < 2 * dbBytes) {
    return { run: false, reason: 'not enough free disk space to compact safely', freeRatio };
  }
  return { run: true, reason: `${pct} of the database is unused space`, freeRatio };
}

/**
 * Whether the weekly compaction check is due: at most once a week, in the quiet hours after the nightly maintenance
 * (from 30 minutes to 3.5 hours after the backup time).
 */
export function compactionDue(now: Date, backupTime: string, lastCheckAt: number): boolean {
  if (now.getTime() - lastCheckAt < 7 * DAY - 12 * 3_600_000) return false;
  const [hh, mm] = backupTime.split(':').map(Number) as [number, number];
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const since = (((minutesNow - (hh * 60 + mm + 30)) % 1440) + 1440) % 1440;
  return since < 180;
}

export interface CompactionResult {
  beforeBytes: number;
  afterBytes: number;
  ms: number;
}

/** Rewrites the database without its unused pages. Blocks until it's done; throws if SQLite can't. */
export function vacuum(store: Store): CompactionResult {
  const beforeBytes = dbFileBytes(store.path);
  const started = performance.now();
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.db.exec('VACUUM');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { beforeBytes, afterBytes: dbFileBytes(store.path), ms: Math.round(performance.now() - started) };
}

export interface CleanupResult {
  deliveries: number;
  alertEvents: number;
}

/** Frees space when the disk is nearly full: old webhook delivery logs and alert history go, readings stay. */
export function emergencyCleanup(store: Store, now: number): CleanupResult {
  const cutoff = now - EMERGENCY_KEEP_MS;
  const deliveries = Number(store.db.prepare('DELETE FROM webhook_deliveries WHERE at < ?').run(cutoff).changes);
  const alertEvents = Number(store.db.prepare('DELETE FROM alert_events WHERE at < ?').run(cutoff).changes);
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { deliveries, alertEvents };
}
