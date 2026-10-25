import { copyFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../db.js';

/** Daily backups: rapthooker-YYYY-MM-DD.db */
export const BACKUP_RE = /^rapthooker-(\d{4}-\d{2}-\d{2})\.db$/;
/** The database as it was before a restore: pre-restore-YYYY-MM-DDTHH-MM-SS.db */
export const PRE_RESTORE_RE = /^pre-restore-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.db$/;
/** Weekly CSV folders: csv/YYYY-MM-DD */
export const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

export const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 2026-10-24T02-49-15, local time (safe in file names everywhere). */
export const localStamp = (d: Date) =>
  `${localDate(d)}T${[d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('-')}`;

const removeSideFiles = (file: string) => {
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true });
};

/**
 * A consistent copy of the live database (SQLite's online backup, so recording carries on) in `file`. The copy is
 * switched from WAL to a plain rollback journal so it's a single self-contained file that opens anywhere.
 */
export async function snapshot(store: Store, file: string): Promise<void> {
  const tmp = `${file}.partial`;
  rmSync(tmp, { force: true });
  removeSideFiles(tmp);
  try {
    await store.backupTo(tmp);
    const db = new DatabaseSync(tmp);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
    } finally {
      db.close();
    }
    removeSideFiles(tmp);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    removeSideFiles(tmp);
    throw err;
  }
}

/** Deletes all but the newest `keep` files in dir whose names match (names sort by date). */
export async function pruneFiles(dir: string, re: RegExp, keep: number, recursive = false): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const old = (await readdir(dir))
    .filter((f) => re.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) await rm(join(dir, f), { force: true, recursive });
  return old;
}

/** Copies a file into dir as `name`, safely: a .partial copy, flushed to the device, then renamed. */
export async function copyInto(src: string, dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const dest = join(dir, name);
  const tmp = `${dest}.partial`;
  await rm(tmp, { force: true });
  await copyFile(src, tmp);
  const fh = await open(tmp, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, dest);
  } catch {
    // Some filesystems (FAT on some kernels) won't rename over an existing file.
    await rm(dest, { force: true });
    await rename(tmp, dest);
  }
  return dest;
}

/** Copies every file in srcDir into destDir (replacing destDir). */
export async function copyFolder(srcDir: string, destDir: string): Promise<void> {
  const tmp = `${destDir}.partial`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  for (const f of await readdir(srcDir)) {
    if ((await stat(join(srcDir, f))).isFile()) await copyInto(join(srcDir, f), tmp, f);
  }
  await rm(destDir, { recursive: true, force: true });
  await rename(tmp, destDir);
}
