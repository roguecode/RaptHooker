import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_BACKUP_SETTINGS, DEFAULT_PILL_MODEL, type BackupSettings, type Brew, type Pill } from '@rapthooker/shared';
import { MIGRATIONS, Store } from '../db.js';
import { Maintenance, type MaintenanceOptions } from '../maintenance.js';
import { Settings } from '../settings.js';
import { applyPendingRestore, inspectBackup, RestoreError } from '../restore.js';
import { backupRoutes } from '../routes/backups.js';
import type { RouteContext } from '../routes/context.js';
import { S3Client, signV4, testS3 } from '../backup/s3.js';
import { usbMounted } from '../backup/usb.js';
import { silent, tempStore } from './helpers.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function temp() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  return t;
}

const DAY = 86_400_000;
const SATURDAY = new Date(2026, 9, 24, 3, 30);
const SUNDAY = new Date(2026, 9, 25, 3, 30);

function backups(patch: Partial<BackupSettings> = {}): { backups(): BackupSettings } {
  const value = { ...structuredClone(DEFAULT_BACKUP_SETTINGS), usb: false, weeklyCsv: false, ...patch };
  return { backups: () => value };
}

function maintenance(store: Store, opts: Partial<MaintenanceOptions> = {}) {
  return new Maintenance(store, silent, { backupDir: '', backupTime: '03:15', keep: 7, rawRetentionDays: 0, now: () => SATURDAY, ...opts });
}

const isSqlite = (file: string) => readFileSync(file).subarray(0, 16).toString('latin1') === 'SQLite format 3\0';

describe('daily backups on the hub', () => {
  it('backs up to <dataDir>/backups by default and keeps the newest few', async () => {
    const t = temp();
    t.store.setMeta('marker', 'live');
    const m = maintenance(t.store, { keep: 2 });
    expect(m.dir).toBe(join(t.dir, 'backups'));
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) expect(await m.backup(day)).toBe(join(m.dir, `rapthooker-${day}.db`));
    expect(readdirSync(m.dir).sort()).toEqual(['rapthooker-2026-10-02.db', 'rapthooker-2026-10-03.db']);
    expect(m.status()).toEqual([
      expect.objectContaining({ target: 'local', ok: true, error: null, file: join(m.dir, 'rapthooker-2026-10-03.db') }),
    ]);

    // A single self-contained file (no WAL) with the data in it.
    const copy = new DatabaseSync(join(m.dir, 'rapthooker-2026-10-03.db'), { readOnly: true });
    expect(copy.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(copy.prepare("SELECT value FROM meta WHERE key = 'marker'").get()).toEqual({ value: 'live' });
    copy.close();
    expect(readdirSync(m.dir)).toHaveLength(2);
  });

  it('honours backup.dir from the config', async () => {
    const t = temp();
    const dir = join(t.dir, 'elsewhere');
    const m = maintenance(t.store, { backupDir: dir });
    await m.backup('2026-10-01');
    expect(readdirSync(dir)).toEqual(['rapthooker-2026-10-01.db']);
    expect(existsSync(join(t.dir, 'backups'))).toBe(false);
  });

  it('runs once a day after the backup time', async () => {
    const t = temp();
    let now = new Date(2026, 9, 24, 3, 10);
    const m = maintenance(t.store, { now: () => now });
    await m.tick();
    expect(existsSync(m.dir)).toBe(false);
    now = new Date(2026, 9, 24, 3, 20);
    await m.tick();
    expect(readdirSync(m.dir)).toEqual(['rapthooker-2026-10-24.db']);
    expect(t.store.getMeta('lastDailyRun')).toBe('2026-10-24');
    const spy = vi.spyOn(m, 'backup');
    await m.tick();
    expect(spy).not.toHaveBeenCalled();
  });
});

// The backup routes on their own, with a stand-in for the owner check.
async function routes(store: Store, m: Maintenance) {
  const app = Fastify();
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.message });
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  });
  const owner = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.headers['x-owner'] !== 'yes') return reply.code(403).send({ error: 'owner only' });
    },
  };
  backupRoutes({ app, s: { store, settings: new Settings(store), maintenance: m }, owner } as unknown as RouteContext);
  await app.ready();
  cleanups.push(() => app.close());
  return app;
}

const OWNER = { 'x-owner': 'yes' };

describe('backup routes', () => {
  it('lists the backups and downloads only listed files', async () => {
    const t = temp();
    const m = maintenance(t.store);
    await m.backup('2026-10-01');
    const app = await routes(t.store, m);

    expect((await app.inject({ url: '/api/backups' })).statusCode).toBe(403);
    const overview = (await app.inject({ url: '/api/backups', headers: OWNER })).json();
    expect(overview.dir).toBe(m.dir);
    expect(overview.files).toEqual([expect.objectContaining({ name: 'rapthooker-2026-10-01.db', kind: 'daily' })]);
    expect(overview.files[0].bytes).toBeGreaterThan(0);
    expect(overview.targets).toEqual([expect.objectContaining({ target: 'local', ok: true })]);

    const ok = await app.inject({ url: '/api/backups/download?file=rapthooker-2026-10-01.db', headers: OWNER });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-disposition']).toContain('rapthooker-2026-10-01.db');
    expect(ok.rawPayload.equals(readFileSync(join(m.dir, 'rapthooker-2026-10-01.db')))).toBe(true);

    for (const file of ['../test.db', 'test.db', '..%2F..%2Ftest.db', '/etc/passwd', 'backups/rapthooker-2026-10-01.db', '..\\test.db']) {
      const res = await app.inject({ url: `/api/backups/download?file=${encodeURIComponent(file)}`, headers: OWNER });
      expect(res.statusCode, file).toBe(404);
    }
    expect((await app.inject({ url: '/api/backups/download?file=rapthooker-2026-10-01.db' })).statusCode).toBe(403);
  });

  it('streams a fresh copy and deletes the temporary file', async () => {
    const t = temp();
    t.store.setMeta('marker', 'now');
    const app = await routes(t.store, maintenance(t.store));
    const res = await app.inject({ url: '/api/backups/now.db', headers: OWNER });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/rapthooker-\d{4}-\d{2}-\d{2}T[\d-]+\.db/);
    expect(res.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3');
    await vi.waitFor(() => expect(readdirSync(t.dir).filter((f) => f.startsWith('download-'))).toEqual([]));
  });

  it('backs up now', async () => {
    const t = temp();
    const app = await routes(t.store, maintenance(t.store));
    const res = await app.inject({ method: 'POST', url: '/api/backups/run', headers: OWNER });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toHaveLength(1);
  });

  it('keeps the saved S3 secret when the masked placeholder comes back', async () => {
    const t = temp();
    const app = await routes(t.store, maintenance(t.store));
    const s3 = { ...DEFAULT_BACKUP_SETTINGS.s3, bucket: 'b', accessKeyId: 'AKID', secretAccessKey: 'top-secret' };
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings/backups',
      headers: OWNER,
      payload: { ...DEFAULT_BACKUP_SETTINGS, s3 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().s3.secretAccessKey).toBe('••••••');
    await app.inject({
      method: 'PUT',
      url: '/api/settings/backups',
      headers: OWNER,
      payload: { ...DEFAULT_BACKUP_SETTINGS, s3: { ...s3, secretAccessKey: '••••••' } },
    });
    expect(new Settings(t.store).backups().s3.secretAccessKey).toBe('top-secret');
    expect((await app.inject({ url: '/api/settings/backups' })).statusCode).toBe(403);
  });
});

/** A RaptHooker database file with a marker in its meta table. */
async function databaseFile(dir: string, name: string, marker: string): Promise<string> {
  const s = new Store(join(dir, `${name}.source`));
  s.setMeta('marker', marker);
  const file = join(dir, name);
  await s.backupTo(file);
  s.close();
  return file;
}

const marker = (file: string) => {
  const s = new Store(file);
  try {
    return s.getMeta('marker');
  } finally {
    s.close();
  }
};

describe('restoring', () => {
  it('checks that a file is a RaptHooker database', async () => {
    const t = temp();
    const junk = join(t.dir, 'junk.db');
    writeFileSync(junk, 'this is not a database, just some words in a file that is long enough to look like one');
    expect(() => inspectBackup(junk)).toThrow(/isn't an SQLite database/);

    const other = join(t.dir, 'other.db');
    const o = new DatabaseSync(other);
    o.exec('CREATE TABLE recipes (id TEXT)');
    o.close();
    expect(() => inspectBackup(other)).toThrow(/no meta, pills, readings tables/);

    const newer = join(t.dir, 'newer.db');
    const n = new DatabaseSync(newer);
    n.exec(MIGRATIONS[0]!);
    n.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    n.close();
    expect(() => inspectBackup(newer)).toThrow(/newer version of RaptHooker/);

    const good = await databaseFile(t.dir, 'good.db', 'x');
    expect(inspectBackup(good)).toEqual({ schema: MIGRATIONS.length, pills: 0, brews: 0, readings: 0 });
    // Looking at it leaves nothing behind.
    expect(existsSync(`${good}-wal`)).toBe(false);
    expect(existsSync(`${good}-shm`)).toBe(false);
    try {
      inspectBackup(junk);
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreError);
      expect((err as RestoreError).statusCode).toBe(400);
    }
  });

  it('accepts an uploaded database or a listed backup, then asks for a restart', async () => {
    const t = temp();
    const restart = vi.fn(() => false);
    const m = maintenance(t.store, { restart });
    const app = await routes(t.store, m);
    const pending = join(t.dir, 'restore-pending.db');

    const junk = await app.inject({
      method: 'POST',
      url: '/api/backups/restore',
      headers: { ...OWNER, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('definitely not a database, but long enough to be read as one'),
    });
    expect(junk.statusCode).toBe(400);
    expect(junk.json().error).toMatch(/isn't a RaptHooker backup/);
    expect(existsSync(pending)).toBe(false);

    const upload = await databaseFile(t.dir, 'upload.db', 'uploaded');
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/restore',
      headers: { ...OWNER, 'content-type': 'application/octet-stream' },
      payload: readFileSync(upload),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restarting: false, pills: 0, brews: 0, readings: 0 });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(marker(pending)).toBe('uploaded');
    expect(readdirSync(t.dir).filter((f) => f.startsWith('restore-upload'))).toEqual([]);

    await m.backup('2026-10-01');
    const listed = await app.inject({
      method: 'POST',
      url: '/api/backups/restore',
      headers: OWNER,
      payload: { file: 'rapthooker-2026-10-01.db' },
    });
    expect(listed.statusCode).toBe(200);
    const sneaky = await app.inject({ method: 'POST', url: '/api/backups/restore', headers: OWNER, payload: { file: '../test.db' } });
    expect(sneaky.statusCode).toBe(404);
    const viewer = await app.inject({ method: 'POST', url: '/api/backups/restore', payload: { file: 'rapthooker-2026-10-01.db' } });
    expect(viewer.statusCode).toBe(403);
  });

  it('swaps the backup in at startup, migrating it and keeping the old data', async () => {
    const t = temp();
    const dir = join(t.dir, 'data');
    mkdirSync(dir);
    const current = new Store(join(dir, 'rapthooker.db'));
    current.setMeta('marker', 'current');
    current.close();
    // An older backup (schema v1 only).
    const old = new DatabaseSync(join(dir, 'restore-pending.db'));
    old.exec(MIGRATIONS[0]!);
    old.exec('PRAGMA user_version = 1');
    old.prepare("INSERT INTO meta (key, value) VALUES ('marker', 'backup')").run();
    old.close();
    for (const stamp of ['2026-01-01T00-00-00', '2026-02-01T00-00-00', '2026-03-01T00-00-00']) {
      writeFileSync(join(dir, `pre-restore-${stamp}.db`), 'old');
    }

    expect(applyPendingRestore(dir, silent, SATURDAY)).toBe(true);
    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      'pre-restore-2026-02-01T00-00-00.db',
      'pre-restore-2026-03-01T00-00-00.db',
      'pre-restore-2026-10-24T03-30-00.db',
      'rapthooker.db',
    ]);
    const restored = new Store(join(dir, 'rapthooker.db'));
    expect(restored.schemaVersion).toBe(MIGRATIONS.length);
    expect(restored.getMeta('marker')).toBe('backup');
    expect(JSON.parse(restored.getMeta('lastRestore')!)).toEqual({
      at: SATURDAY.getTime(),
      previous: 'pre-restore-2026-10-24T03-30-00.db',
    });
    restored.close();
    expect(marker(join(dir, 'pre-restore-2026-10-24T03-30-00.db'))).toBe('current');
    expect(applyPendingRestore(dir, silent)).toBe(false);
  });

  it('keeps the current data when the backup is no good', () => {
    const t = temp();
    const dir = join(t.dir, 'data');
    mkdirSync(dir);
    const current = new Store(join(dir, 'rapthooker.db'));
    current.setMeta('marker', 'current');
    current.close();

    writeFileSync(join(dir, 'restore-pending.db'), 'garbage garbage garbage garbage garbage garbage garbage garbage');
    expect(applyPendingRestore(dir, silent, SATURDAY)).toBe(false);
    expect(marker(join(dir, 'rapthooker.db'))).toBe('current');
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(false);
    expect(existsSync(join(dir, 'restore-failed-2026-10-24T03-30-00.db'))).toBe(true);

    const newer = new DatabaseSync(join(dir, 'restore-pending.db'));
    newer.exec(MIGRATIONS[0]!);
    newer.exec('PRAGMA user_version = 999');
    newer.close();
    expect(applyPendingRestore(dir, silent, SUNDAY)).toBe(false);
    expect(marker(join(dir, 'rapthooker.db'))).toBe('current');
    expect(readdirSync(dir).filter((f) => f.startsWith('pre-restore'))).toEqual([]);
  });

  it('finishes a swap that was cut short', async () => {
    const t = temp();
    const dir = join(t.dir, 'data');
    mkdirSync(dir);
    // The current database was already moved aside when the power went.
    await databaseFile(dir, 'pre-restore-2026-10-24T03-29-00.db', 'current');
    await databaseFile(dir, 'restore-pending.db', 'backup');
    expect(applyPendingRestore(dir, silent, SATURDAY)).toBe(true);
    expect(marker(join(dir, 'rapthooker.db'))).toBe('backup');
    expect(marker(join(dir, 'pre-restore-2026-10-24T03-29-00.db'))).toBe('current');
  });

  it('keeps recent changes in the pre-restore copy, as one file that can be downloaded or restored', async () => {
    const t = temp();
    const dir = join(t.dir, 'data');
    mkdirSync(dir);
    const live = new Store(join(t.dir, 'live.db'));
    live.setMeta('marker', 'recent');
    // As the files are on disk after a crash: the recent change is only in the -wal file.
    copyFileSync(join(t.dir, 'live.db'), join(dir, 'rapthooker.db'));
    copyFileSync(join(t.dir, 'live.db-wal'), join(dir, 'rapthooker.db-wal'));
    live.close();
    await databaseFile(dir, 'restore-pending.db', 'backup');

    expect(applyPendingRestore(dir, silent, SATURDAY)).toBe(true);
    const copy = join(dir, 'pre-restore-2026-10-24T03-30-00.db');
    expect(existsSync(`${copy}-wal`)).toBe(false);
    const alone = join(t.dir, 'alone.db');
    copyFileSync(copy, alone);
    expect(marker(alone)).toBe('recent');
  });
});

describe('USB stick', () => {
  it('copies backups to a mounted stick and says when there is none', async () => {
    const t = temp();
    const usbDir = join(t.dir, 'usb');
    mkdirSync(usbDir);
    let mounted = false;
    const m = maintenance(t.store, { settings: backups({ usb: true }), usbDir, usbCheck: async () => mounted });

    await m.backupNow();
    expect(readdirSync(usbDir)).toEqual([]);
    expect(m.status().find((s) => s.target === 'usb')).toEqual(
      expect.objectContaining({ ok: null, error: null, note: 'No USB stick plugged in', at: null }),
    );
    expect((await m.overview()).usbPresent).toBe(false);

    mounted = true;
    for (let d = 1; d <= 30; d++) writeFileSync(join(usbDir, `rapthooker-2026-09-${String(d).padStart(2, '0')}.db`), 'old');
    writeFileSync(join(usbDir, 'my-notes.txt'), 'keep me');
    await m.backupNow();
    const files = readdirSync(usbDir);
    expect(files).toContain('rapthooker-2026-10-24.db');
    expect(files).not.toContain('rapthooker-2026-09-01.db');
    expect(files).toContain('my-notes.txt');
    expect(files.filter((f) => f.startsWith('rapthooker-'))).toHaveLength(30);
    expect(isSqlite(join(usbDir, 'rapthooker-2026-10-24.db'))).toBe(true);
    const usb = m.status().find((s) => s.target === 'usb')!;
    expect(usb).toEqual(expect.objectContaining({ ok: true, error: null, note: null, file: join(usbDir, 'rapthooker-2026-10-24.db') }));

    // Unplugged again: the last copy is still reported, without an error.
    mounted = false;
    await m.backupNow();
    expect(m.status().find((s) => s.target === 'usb')).toEqual(
      expect.objectContaining({ ok: null, error: null, note: 'No USB stick plugged in', at: usb.at }),
    );
  });

  it('reports a stick it cannot write to', async () => {
    const t = temp();
    const usbDir = join(t.dir, 'usb-file');
    writeFileSync(usbDir, 'a file where the folder should be');
    const m = maintenance(t.store, { settings: backups({ usb: true }), usbDir, usbCheck: async () => true });
    await m.backupNow();
    const usb = m.status().find((s) => s.target === 'usb')!;
    expect(usb.ok).toBe(false);
    expect(usb.error).toMatch(/USB stick/);
    expect(m.status()[0]!.ok).toBe(true);
  });

  it("doesn't think a plain folder is a stick", async () => {
    const t = temp();
    expect(await usbMounted(t.dir)).toBe(false);
  });

  it('leaves the stick out when USB copies are off', () => {
    const t = temp();
    expect(
      maintenance(t.store, { settings: backups({ usb: false }) })
        .status()
        .map((s) => s.target),
    ).toEqual(['local']);
  });
});

const fakePill = (id: string, name: string) =>
  ({ id, name, offsets: { gravity: 0, temperature: 0 }, model: DEFAULT_PILL_MODEL, archived: false }) as unknown as Pill;

const fakeBrew = (id: string, pillId: string, name: string, startedAt: number, endedAt: number | null) =>
  ({ id, pillId, name, startedAt, endedAt }) as unknown as Brew;

function addReadings(store: Store, pillId: string, now: number) {
  for (let i = 0; i < 10; i++) {
    store.addReading(pillId, {
      ts: now - i * 3_600_000,
      sg: 1.05 - i * 0.001,
      temp: 19.5,
      velocity: -2,
      battery: 90,
      rssi: -60,
      x: 0,
      y: 0,
      z: 1,
      flags: 0,
    });
  }
  store.addReading(pillId, { ts: now - 10 * DAY, sg: 1.06, temp: 18, velocity: null, battery: 95, rssi: -60, x: 0, y: 0, z: 1, flags: 0 });
}

describe('weekly CSV', () => {
  it('saves recent brews and each pill on Sundays, keeping 8 weeks', async () => {
    const t = temp();
    const now = SUNDAY.getTime();
    addReadings(t.store, 'p1', now);
    const usbDir = join(t.dir, 'usb');
    mkdirSync(usbDir);
    const m = maintenance(t.store, {
      now: () => SUNDAY,
      settings: backups({ weeklyCsv: true, usb: true }),
      usbDir,
      usbCheck: async () => true,
      pills: { list: () => [fakePill('p1', 'Big Stout'), fakePill('p2', 'Spare')] },
      brews: {
        list: () => [
          fakeBrew('b1', 'p1', 'Oatmeal Stout', now - 5 * DAY, null),
          fakeBrew('b2', 'p1', 'Old Ale', now - 120 * DAY, now - 90 * DAY),
          fakeBrew('b3', 'gone', 'Lost', now - 5 * DAY, null),
        ],
      },
    });
    const csvRoot = join(m.dir, 'csv');
    for (let w = 1; w <= 9; w++)
      mkdirSync(join(csvRoot, `2026-0${Math.ceil(w / 5) + 5}-${String(w).padStart(2, '0')}`), { recursive: true });

    await m.runDaily();
    const folder = join(csvRoot, '2026-10-25');
    expect(readdirSync(folder).sort()).toEqual(['brew-2026-10-20-Oatmeal-Stout.csv', 'pill-Big-Stout-last-7-days.csv']);
    const brew = readFileSync(join(folder, 'brew-2026-10-20-Oatmeal-Stout.csv'), 'utf8').trim().split('\n');
    expect(brew[0]).toMatch(/^timestamp,unix_ms,gravity_sg,/);
    expect(brew).toHaveLength(11);
    expect(brew[1]).toMatch(/,1\.04100,/);
    expect(brew[10]).toMatch(/,1\.05000,/);
    expect(readFileSync(join(folder, 'pill-Big-Stout-last-7-days.csv'), 'utf8').trim().split('\n')).toHaveLength(11);
    expect(readdirSync(csvRoot)).toHaveLength(8);
    expect(readdirSync(join(usbDir, 'csv', '2026-10-25')).sort()).toEqual(readdirSync(folder).sort());
    expect((await m.overview()).csv).toEqual({ at: now, folder, error: null });

    // Not again on Monday.
    const monday = maintenance(t.store, {
      now: () => new Date(2026, 9, 26, 3, 30),
      settings: backups({ weeklyCsv: true }),
      pills: { list: () => [] },
      brews: { list: () => [] },
    });
    await monday.runDaily();
    expect(existsSync(join(csvRoot, '2026-10-26'))).toBe(false);
  });

  it('does nothing on Sundays when switched off', async () => {
    const t = temp();
    const m = maintenance(t.store, {
      now: () => SUNDAY,
      settings: backups({ weeklyCsv: false }),
      pills: { list: () => [] },
      brews: { list: () => [] },
    });
    await m.runDaily();
    expect(existsSync(join(m.dir, 'csv'))).toBe(false);
  });

  it('makes up for a missed Sunday the next day', async () => {
    const t = temp();
    // The last export was a little after the backup time the Sunday before; this Sunday the hub was off.
    t.store.setMeta('lastCsv', JSON.stringify({ at: new Date(2026, 9, 4, 3, 20).getTime(), folder: null, error: null }));
    const m = maintenance(t.store, {
      now: () => new Date(2026, 9, 12, 3, 16),
      settings: backups({ weeklyCsv: true }),
      pills: { list: () => [] },
      brews: { list: () => [] },
    });
    await m.runDaily();
    expect(existsSync(join(m.dir, 'csv', '2026-10-12'))).toBe(true);
  });
});

describe('leftovers', () => {
  it('tidies up copies cut short by a restart', () => {
    const t = temp();
    const backupsDir = join(t.dir, 'backups');
    mkdirSync(backupsDir);
    const left = [
      join(t.dir, 'pre-update-2026-10-24T02-49-15.db.partial'),
      join(t.dir, 'pre-update-2026-10-24T02-49-15.db.partial-wal'),
      join(t.dir, 'download-abc123.partial'),
      join(backupsDir, 'rapthooker-2026-10-20.db.partial'),
    ];
    const kept = [join(t.dir, 'pre-update-2026-10-23T02-49-15.db'), join(backupsDir, 'rapthooker-2026-10-21.db')];
    for (const f of [...left, ...kept]) writeFileSync(f, 'x');
    maintenance(t.store);
    expect(left.filter((f) => existsSync(f))).toEqual([]);
    expect(kept.filter((f) => existsSync(f))).toEqual(kept);
  });
});

describe('S3 signing (AWS Signature Version 4)', () => {
  // The worked examples in https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  const creds = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    date: new Date('2013-05-24T00:00:00Z'),
  };
  const host = 'examplebucket.s3.amazonaws.com';
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('matches the GET Object example', () => {
    const signed = signV4({ ...creds, method: 'GET', path: '/test.txt', headers: { host, range: 'bytes=0-9' }, payloadHash: EMPTY });
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        `host:${host}`,
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY,
      ].join('\n'),
    );
    expect(signed.stringToSign).toBe(
      'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    );
    expect(signed.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches the PUT Object example', () => {
    const body = 'Welcome to Amazon S3.';
    const payloadHash = createHash('sha256').update(body).digest('hex');
    expect(payloadHash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const client = new S3Client({
      ...DEFAULT_BACKUP_SETTINGS.s3,
      endpoint: 'https://s3.amazonaws.com',
      bucket: 'examplebucket',
      pathStyle: false,
      ...creds,
    });
    const { path } = client.target('test$file.text');
    expect(path).toBe('/test%24file.text');
    const signed = signV4({
      ...creds,
      method: 'PUT',
      path,
      headers: { host, date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash,
    });
    expect(signed.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('matches the GET Bucket Lifecycle and list objects examples', () => {
    const lifecycle = signV4({ ...creds, method: 'GET', path: '/', query: { lifecycle: '' }, headers: { host }, payloadHash: EMPTY });
    expect(lifecycle.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
    const list = signV4({
      ...creds,
      method: 'GET',
      path: '/',
      query: { prefix: 'J', 'max-keys': '2' },
      headers: { host },
      payloadHash: EMPTY,
    });
    expect(list.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('addresses buckets path-style or virtual-host style', () => {
    const base = { ...DEFAULT_BACKUP_SETTINGS.s3, bucket: 'my-bucket', accessKeyId: 'a', secretAccessKey: 's', region: 'eu-west-1' };
    expect(new S3Client({ ...base, endpoint: '', pathStyle: false }).target('rapthooker/a b.db')).toEqual({
      host: 'my-bucket.s3.eu-west-1.amazonaws.com',
      hostname: 'my-bucket.s3.eu-west-1.amazonaws.com',
      path: '/rapthooker/a%20b.db',
    });
    expect(new S3Client({ ...base, endpoint: 'http://nas.example.com:9000', pathStyle: true }).target('x.db')).toEqual({
      host: 'nas.example.com:9000',
      hostname: 'nas.example.com',
      path: '/my-bucket/x.db',
    });
    expect(() => new S3Client({ ...base, bucket: '' })).toThrow(/bucket/);
  });
});

/** A tiny S3 look-alike that checks every request's signature. */
async function fakeS3() {
  const objects = new Map<string, Buffer>();
  const state = { fail: null as string | null, requests: [] as string[], badSignatures: 0 };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const [rawPath, rawQuery = ''] = (req.url ?? '/').split('?');
      state.requests.push(`${req.method} ${req.url}`);
      const auth = String(req.headers.authorization ?? '');
      const m =
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/(\d{8})\/us-east-1\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
          auth,
        );
      const amz = String(req.headers['x-amz-date'] ?? '');
      const query = Object.fromEntries(
        rawQuery
          .split('&')
          .filter(Boolean)
          .map((kv) => kv.split('=').map(decodeURIComponent) as [string, string]),
      );
      const signedNames = (m?.[2] ?? '').split(';').filter((n) => n !== 'x-amz-date' && n !== 'x-amz-content-sha256');
      const expected = signV4({
        method: req.method!,
        path: rawPath!,
        query,
        headers: Object.fromEntries(signedNames.map((n) => [n, String(req.headers[n])])),
        payloadHash: String(req.headers['x-amz-content-sha256']),
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret/KEY',
        region: 'us-east-1',
        date: new Date(amz.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')),
      });
      const hashOk = req.method !== 'PUT' || createHash('sha256').update(body).digest('hex') === req.headers['x-amz-content-sha256'];
      if (!m || m[3] !== expected.signature || !hashOk || state.fail) {
        state.badSignatures += state.fail ? 0 : 1;
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${state.fail ?? 'SignatureDoesNotMatch'}</Code><Message>No.</Message></Error>`,
        );
        return;
      }
      const key = decodeURIComponent(rawPath!.replace(/^\/bucket\/?/, ''));
      if (req.method === 'PUT') {
        objects.set(key, body);
        res.writeHead(200).end();
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else if (req.method === 'GET' && query['list-type'] === '2') {
        const keys = [...objects.keys()].filter((k) => k.startsWith(query.prefix ?? '')).sort();
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys
            .map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${objects.get(k)!.length}</Size></Contents>`)
            .join('')}</ListBucketResult>`,
        );
      } else res.writeHead(400).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const settings = {
    ...DEFAULT_BACKUP_SETTINGS.s3,
    enabled: true,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bucket: 'bucket',
    prefix: 'rapthooker',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret/KEY',
    pathStyle: true,
  };
  return { objects, state, settings };
}

describe('S3 uploads', () => {
  it('uploads the backup, signed, and keeps the newest 30', async () => {
    const t = temp();
    const s3 = await fakeS3();
    for (let d = 1; d <= 30; d++) s3.objects.set(`rapthooker/rapthooker-2026-09-${String(d).padStart(2, '0')}.db`, Buffer.from('old'));
    s3.objects.set('rapthooker/notes & things.txt', Buffer.from('keep'));
    const m = maintenance(t.store, { settings: backups({ s3: s3.settings }) });

    await m.backupNow();
    expect(s3.state.badSignatures).toBe(0);
    const uploaded = s3.objects.get('rapthooker/rapthooker-2026-10-24.db');
    expect(uploaded?.equals(readFileSync(join(m.dir, 'rapthooker-2026-10-24.db')))).toBe(true);
    expect(s3.objects.has('rapthooker/rapthooker-2026-09-01.db')).toBe(false);
    expect(s3.objects.has('rapthooker/rapthooker-2026-09-02.db')).toBe(true);
    expect(s3.objects.has('rapthooker/notes & things.txt')).toBe(true);
    expect(m.status().find((s) => s.target === 's3')).toEqual(
      expect.objectContaining({ ok: true, error: null, note: null, file: 'rapthooker/rapthooker-2026-10-24.db' }),
    );
  });

  it('uploads the weekly CSV files too', async () => {
    const t = temp();
    const s3 = await fakeS3();
    addReadings(t.store, 'p1', SUNDAY.getTime());
    const m = maintenance(t.store, {
      now: () => SUNDAY,
      settings: backups({ s3: s3.settings, weeklyCsv: true }),
      pills: { list: () => [fakePill('p1', 'Stout')] },
      brews: { list: () => [] },
    });
    await m.weeklyCsv();
    expect([...s3.objects.keys()]).toEqual(['rapthooker/csv/2026-10-25/pill-Stout-last-7-days.csv']);
    expect(s3.state.badSignatures).toBe(0);
  });

  it('turns S3 errors into plain words', async () => {
    const t = temp();
    const s3 = await fakeS3();
    await expect(testS3(s3.settings)).resolves.toEqual({ key: 'rapthooker/rapthooker-connection-test.txt', warning: null });
    expect(s3.objects.size).toBe(0);

    s3.state.fail = 'NoSuchBucket';
    await expect(testS3(s3.settings)).rejects.toThrow("There's no bucket with that name at this address (NoSuchBucket)");
    await expect(testS3({ ...s3.settings, secretAccessKey: 'wrong' })).rejects.toThrow(/NoSuchBucket/);
    s3.state.fail = null;
    await expect(testS3({ ...s3.settings, secretAccessKey: 'wrong' })).rejects.toThrow(/SignatureDoesNotMatch/);
    await expect(testS3({ ...s3.settings, endpoint: 'http://127.0.0.1:1' })).rejects.toThrow(/refused the connection/);

    const m = maintenance(t.store, { settings: backups({ s3: { ...s3.settings, secretAccessKey: 'wrong' } }) });
    await m.backupNow();
    expect(m.status().find((s) => s.target === 's3')).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/SignatureDoesNotMatch/) }),
    );
    expect(m.status()[0]!.ok).toBe(true);

    const app = await routes(t.store, m);
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/test-s3',
      headers: OWNER,
      payload: { ...s3.settings, secretAccessKey: 'wrong' },
    });
    expect(res.json()).toEqual({ ok: false, error: expect.stringMatching(/SignatureDoesNotMatch/), warning: null });
  });
});
