import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, Store } from './db.js';
import type { Logger } from './log.js';
import { localStamp, PRE_RESTORE_RE } from './backup/files.js';

export const DB_NAME = 'rapthooker.db';
/** A checked backup waiting to replace the database at the next start. */
export const PENDING_NAME = 'restore-pending.db';
/** How many pre-restore copies of the data are kept. */
export const PRE_RESTORE_KEEP = 3;

export class RestoreError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface BackupSummary {
  schema: number;
  pills: number;
  brews: number;
  readings: number;
}

/** Removes the -wal/-shm files a read-only look at a WAL-mode database leaves behind (only when the WAL is empty). */
function tidySideFiles(file: string): void {
  const wal = `${file}-wal`;
  if (existsSync(wal)) {
    if (statSync(wal).size > 0) return;
    rmSync(wal, { force: true });
  }
  rmSync(`${file}-shm`, { force: true });
}

/**
 * Folds a database's -wal file (changes not yet written into the main file) into the main file, so the .db file on
 * its own holds everything: copying, downloading or restoring just the .db would otherwise lose those changes.
 * Only for databases nothing else has open.
 */
export function foldWal(file: string): void {
  if (!existsSync(`${file}-wal`)) return;
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  tidySideFiles(file);
}

/**
 * Checks, without changing it, that a file is a RaptHooker database this version can use: an SQLite database with
 * the meta, pills and readings tables, a schema no newer than this version's, that passes SQLite's quick check.
 */
export function inspectBackup(file: string): BackupSummary {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    throw new RestoreError(`Couldn't open that file: ${(err as Error).message}`);
  }
  try {
    let tables: Set<string>;
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[];
      tables = new Set(rows.map((r) => r.name));
    } catch {
      throw new RestoreError("That file isn't a RaptHooker backup (it isn't an SQLite database)");
    }
    const missing = ['meta', 'pills', 'readings'].filter((t) => !tables.has(t));
    if (missing.length) {
      throw new RestoreError(
        `That database isn't a RaptHooker backup (it has no ${missing.join(', ')} table${missing.length > 1 ? 's' : ''})`,
      );
    }
    const schema = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (schema < 1) throw new RestoreError("That database isn't a RaptHooker backup (it has no schema version)");
    if (schema > MIGRATIONS.length) {
      throw new RestoreError('That backup is from a newer version of RaptHooker. Update the hub first, then restore it.');
    }
    const check = db.prepare('PRAGMA quick_check').all() as unknown as { quick_check: string }[];
    if (check[0]?.quick_check !== 'ok') throw new RestoreError(`That backup is damaged (${check[0]?.quick_check ?? 'unknown problem'})`);
    const count = (table: string) => (tables.has(table) ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n : 0);
    return { schema, pills: count('pills'), brews: count('brews'), readings: count('readings') };
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    throw new RestoreError(`That backup can't be read: ${(err as Error).message}`);
  } finally {
    db.close();
    try {
      tidySideFiles(file);
    } catch {}
  }
}

function moveAside(file: string, to: string, log: Logger): void {
  try {
    renameSync(file, to);
    log.error({ file: to }, 'the backup that could not be restored was kept');
  } catch (err) {
    log.error({ err: (err as Error).message }, `couldn't move ${basename(file)} aside; deleting it so the hub can start`);
    rmSync(file, { force: true });
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
}

/**
 * Swaps in a backup waiting in <dataDir>/restore-pending.db, before the database is opened. The current database
 * (with its -wal/-shm) becomes pre-restore-<time>.db and the backup becomes rapthooker.db, brought up to this
 * version's schema first. If anything goes wrong the current database stays (or is put back) and the backup is moved
 * to restore-failed-<time>.db. Returns true when a backup was restored.
 */
export function applyPendingRestore(dataDir: string, log: Logger, now = new Date()): boolean {
  const pending = join(dataDir, PENDING_NAME);
  if (!existsSync(pending)) return false;
  const db = join(dataDir, DB_NAME);
  const stamp = localStamp(now);
  const previous = join(dataDir, `pre-restore-${stamp}.db`);
  const failed = join(dataDir, `restore-failed-${stamp}.db`);
  log.warn({ file: pending }, 'restoring a backup');

  let summary: BackupSummary;
  try {
    summary = inspectBackup(pending);
    // Migrate the backup on its own file first: if that fails, nothing has been touched yet.
    const trial = new Store(pending);
    try {
      trial.setMeta('lastRestore', JSON.stringify({ at: now.getTime(), previous: existsSync(db) ? basename(previous) : '' }));
    } finally {
      trial.close();
    }
    tidySideFiles(pending);
    if (existsSync(`${pending}-wal`)) throw new Error('the backup still has unsaved changes after opening it');
  } catch (err) {
    log.error({ err: (err as Error).message }, 'RESTORE FAILED: the backup could not be used. Carrying on with the current data.');
    moveAside(pending, failed, log);
    return false;
  }

  // The pre-restore copy must stand on its own: it can be downloaded or restored later as a single file.
  try {
    if (existsSync(db)) foldWal(db);
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "couldn't fold the current database's recent changes into it; keeping its -wal file alongside",
    );
  }

  // The WAL goes first: a stray -wal next to the restored database would be replayed into it.
  const moved: [string, string][] = [];
  try {
    for (const suffix of ['-wal', '-shm', '']) {
      if (!existsSync(`${db}${suffix}`)) continue;
      renameSync(`${db}${suffix}`, `${previous}${suffix}`);
      moved.push([`${db}${suffix}`, `${previous}${suffix}`]);
    }
    renameSync(pending, db);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'RESTORE FAILED while swapping the files. Putting the current data back.');
    for (const [from, to] of moved.reverse()) {
      try {
        renameSync(to, from);
      } catch (e) {
        log.error({ err: (e as Error).message, file: to }, `COULDN'T PUT ${basename(from)} BACK: it is in ${to}`);
      }
    }
    if (existsSync(pending)) moveAside(pending, failed, log);
    return false;
  }

  log.warn({ ...summary, previous: moved.length ? previous : null }, 'backup restored; the data from before is kept as a pre-restore copy');
  try {
    const old = readdirSync(dataDir)
      .filter((f) => PRE_RESTORE_RE.test(f))
      .sort()
      .reverse()
      .slice(PRE_RESTORE_KEEP);
    for (const f of old) for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `${f}${suffix}`), { force: true });
  } catch (err) {
    log.warn({ err: (err as Error).message }, "couldn't tidy up old pre-restore copies");
  }
  return true;
}

/**
 * Restarts the hub to finish a restore. Under systemd (or in Docker, NODE_ENV=production) it shuts down cleanly and
 * the supervisor starts it again; in development it only says a restart is needed. True when it will restart.
 */
export function restartForRestore(log: Logger): boolean {
  const supervised = Boolean(process.env.INVOCATION_ID) || process.env.NODE_ENV === 'production';
  if (!supervised) {
    log.warn('a backup is waiting to be restored: restart RaptHooker to finish');
    return false;
  }
  log.warn('restarting to restore a backup');
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => process.exit(0), 15_000).unref();
  }, 1000);
  return true;
}
