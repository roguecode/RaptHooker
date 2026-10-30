import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClockGuard } from '../clock.js';
import { COMPACT_AFTER_UPGRADE_KEY, IncompatibleDatabaseError, MIGRATIONS, MIN_SCHEMA_KEY, ROLLUP_MS, Store } from '../db.js';
import { keepPreUpdateCopy, PRE_UPDATE_KEEP } from '../backup/files.js';
import { Maintenance } from '../maintenance.js';
import { PillService } from '../pills.js';
import { APPLE_COMPANY_ID, RAPT_COMPANY_ID, encodeRaptThermometer } from '../ble/rapt.js';
import { CAPTURED, silent } from './helpers.js';

/**
 * People's brewing history lives in this database: an update must never lose or change any of it. These tests start
 * from a database as a released version left it and check that this version keeps every row and value.
 */

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const tempDir = () => (dir = mkdtempSync(join(tmpdir(), 'rapthooker-storage-')));

const PILL = '08b61f452f66';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 6, 1);

/**
 * A database as RaptHooker 0.2.0 and 0.3.0 (schema 3) left it, with something in every table. Keep it as it is when
 * adding a migration: it's what people's hubs have.
 */
function schema3Database(file: string): void {
  const db = new DatabaseSync(file);
  for (const sql of MIGRATIONS.slice(0, 3)) db.exec(sql);
  db.exec('PRAGMA user_version = 3');
  const pill = {
    name: 'Hazy IPA',
    color: '#a78bfa',
    archived: false,
    offsets: { gravity: -0.001, temperature: 0.4 },
    model: { gravitySource: 'pill', tiltPoints: [], velocitySource: 'pill', velocityHours: 24, smoothing: 'off' },
    order: 0,
    info: { firmware: '20250319_055542_b3788ba', deviceType: 'PillG1', payloadVersion: 2 },
  };
  db.prepare('INSERT INTO pills (id, address, json, created_at) VALUES (?, ?, ?, ?)').run(
    PILL,
    '08:B6:1F:45:2F:66',
    JSON.stringify(pill),
    T0,
  );
  const reading = db.prepare(
    'INSERT INTO readings (pill_id, ts, sg, temp, velocity, battery, rssi, x, y, z, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  reading.run(PILL, T0 + 60_000, 1.0546, 20.06, -2.5, 87.5, -61, 410.5, -12.25, 920.0625, 0);
  reading.run(PILL, T0 + 120_000, 1.0544, 20.1, null, 87.5, null, 411, -12, 920, 0);
  // Out of the liquid: kept, but flagged.
  reading.run(PILL, T0 + 180_000, 0.2, 21.3, null, 87, -70, 1000, 0, 5, 1);
  // Older readings were pruned: only their 15-minute averages are left.
  db.prepare(
    `INSERT INTO rollups (pill_id, bucket, n, sg, temp, velocity, velocity_n, battery, rssi, rssi_n, x, y, z, sg_all, sg_n)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(PILL, T0 - DAY, 4, 3 * 1.06, 4 * 19.5, -7.5, 3, 4 * 90, -240, 4, 4 * 400, 4 * -10, 4 * 925, 3 * 1.06 + 0.3, 3);
  db.prepare('INSERT INTO brews (id, pill_id, started_at, ended_at, json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'brew1',
    PILL,
    T0 - DAY,
    null,
    JSON.stringify({ name: 'Hazy IPA #4', style: 'NEIPA', notes: '', og: null, targetFg: 1.012 }),
    T0 - DAY,
  );
  db.prepare('INSERT INTO brew_events (id, brew_id, at, kind, text) VALUES (?, ?, ?, ?, ?)').run('ev1', 'brew1', T0, 'dryhop', 'Citra');
  db.prepare('INSERT INTO webhooks (id, json, created_at, updated_at) VALUES (?, ?, ?, ?)').run('hook1', '{"name":"Brewfather"}', T0, T0);
  db.prepare(
    `INSERT INTO webhook_state (webhook_id, pill_id, last_sent_at, last_reading_ts, last_ok, failures, retry_at, last_gravity, last_temp, cursor_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('hook1', PILL, T0, T0 + 60_000, 1, 0, null, 1.0546, 20.06, T0 + 60_000);
  db.prepare(
    `INSERT INTO webhook_deliveries (webhook_id, pill_id, at, ok, status, duration_ms, method, url, request_body, response_body, error, test)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('hook1', PILL, T0, 1, 200, 120, 'POST', 'https://example.com/hook', '{}', 'ok', null, 0);
  db.prepare('INSERT INTO alert_rules (id, json, created_at) VALUES (?, ?, ?)').run('rule1', '{"kind":"battery_below"}', T0);
  db.prepare('INSERT INTO alert_state (rule_id, pill_id, active, last_fired_at) VALUES (?, ?, ?, ?)').run('rule1', PILL, 1, T0);
  db.prepare('INSERT INTO alert_events (rule_id, rule_name, pill_id, at, kind, message, value) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'rule1',
    'Battery low',
    PILL,
    T0,
    'fired',
    'Battery at 9%',
    9,
  );
  db.prepare('INSERT INTO push_subs (endpoint, json, user, created_at) VALUES (?, ?, ?, ?)').run('https://push.example', '{}', 'owner', T0);
  db.prepare('INSERT INTO api_tokens (id, name, scope, hash, hint, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'tok1',
    'Home Assistant',
    'read',
    'hash',
    'abcd',
    T0,
    null,
  );
  db.prepare('INSERT INTO channels (id, json, created_at, last_at, last_ok, last_error) VALUES (?, ?, ?, ?, ?, ?)').run(
    'ch1',
    '{"kind":"ntfy"}',
    T0,
    null,
    null,
    null,
  );
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('hub', '{"name":"Brewery"}');
  db.close();
}

type Rows = Record<string, Record<string, unknown>[]>;

/** Every row of every table, as these columns (all of them, unless given). */
function dump(db: DatabaseSync, columns?: Record<string, string[]>): { rows: Rows; columns: Record<string, string[]> } {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  )
    .map((t) => t.name)
    .filter((t) => !columns || t in columns);
  const rows: Rows = {};
  const cols: Record<string, string[]> = {};
  for (const table of tables) {
    cols[table] = columns?.[table] ?? (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const list = cols[table]!.map((c) => `"${c}"`).join(', ');
    rows[table] = db.prepare(`SELECT ${list} FROM ${table} ORDER BY ${cols[table]!.map((_, i) => i + 1).join(', ')}`).all() as Record<
      string,
      unknown
    >[];
  }
  return { rows, columns: cols };
}

describe('upgrading the database', () => {
  it('keeps every row and value a released version stored', () => {
    const file = join(tempDir(), 'rapthooker.db');
    schema3Database(file);
    const raw = new DatabaseSync(file);
    const before = dump(raw);
    raw.close();
    expect(Object.values(before.rows).every((rows) => rows.length > 0)).toBe(true);

    const store = new Store(file);
    try {
      expect(store.schemaVersion).toBe(MIGRATIONS.length);
      const after = dump(store.db, before.columns);
      expect(Object.keys(after.rows).sort()).toEqual(Object.keys(before.rows).sort());
      for (const table of Object.keys(before.rows)) {
        // An upgrade may add bookkeeping to meta; everything that was there stays as it was.
        const rows = table === 'meta' ? after.rows[table]!.filter((r) => r.key !== COMPACT_AFTER_UPGRADE_KEY) : after.rows[table];
        expect(rows, table).toEqual(before.rows[table]);
      }
    } finally {
      store.close();
    }
  });

  it('averages the old 15-minute buckets as before', () => {
    const file = join(tempDir(), 'rapthooker.db');
    schema3Database(file);
    const store = new Store(file);
    try {
      const h = store.history(PILL, T0 - 2 * DAY, T0 - DAY + ROLLUP_MS, {
        maxPoints: 10,
        gapMs: DAY,
        offsets: { gravity: 0, temperature: 0 },
      });
      const i = h.ts.length - 1;
      expect(h.gravity[i]).toBeCloseTo(1.06, 6);
      expect(h.temperature[i]).toBeCloseTo(19.5, 6);
      expect(h.battery[i]).toBeCloseTo(90, 6);
      expect(h.velocity[i]).toBeCloseTo(-2.5, 6);
      expect(h.rssi[i]).toBe(-60);
      expect(h.tilt[i]).not.toBeNull();
      expect(h.implausible[i]).toBe(false);
      expect(store.prunedRollups(PILL, T0 - 2 * DAY, T0)).toEqual([
        { bucket: T0 - DAY, n: 3, sg: expect.closeTo(1.06, 6), temp: 19.5, x: 400, y: -10, z: 925 },
      ]);
    } finally {
      store.close();
    }
  });

  it("stores a development build's thermometer readings without the zeros", () => {
    const file = join(tempDir(), 'rapthooker.db');
    schema3Database(file);
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO pills (id, address, json, created_at) VALUES (?, ?, ?, ?)').run(
      'thermo',
      'D0:26:25:B4:48:95',
      JSON.stringify({ kind: 'thermometer', name: 'Fridge', color: '#f472b6', offsets: { gravity: 0, temperature: 0 }, info: {} }),
      T0,
    );
    db.prepare(
      'INSERT INTO readings (pill_id, ts, sg, temp, velocity, battery, rssi, x, y, z, flags) VALUES (?, ?, 0, ?, NULL, 0, ?, 0, 0, 0, 2)',
    ).run('thermo', T0, 15.3, -48);
    db.prepare(
      `INSERT INTO rollups (pill_id, bucket, n, sg, temp, velocity, velocity_n, battery, rssi, rssi_n, x, y, z, sg_all, sg_n)
       VALUES ('thermo', ?, 1, 0, 15.3, 0, 0, 0, -48, 1, 0, 0, 0, 0, 0)`,
    ).run(T0);
    db.close();
    const store = new Store(file);
    try {
      expect(store.latestReadings('thermo', 1)[0]).toEqual({
        ts: T0,
        sg: null,
        temp: 15.3,
        velocity: null,
        battery: null,
        rssi: -48,
        x: null,
        y: null,
        z: null,
        flags: 0,
      });
      expect(
        store.db.prepare("SELECT n, temp_missing, battery_missing, xyz_missing, sg_missing FROM rollups WHERE pill_id = 'thermo'").get(),
      ).toEqual({ n: 1, temp_missing: 0, battery_missing: 1, xyz_missing: 1, sg_missing: 1 });
      // The pill's readings are as they were.
      expect(store.latestReadings(PILL, 1)[0]).toMatchObject({ sg: 0.2, battery: 87, x: 1000, flags: 1 });
    } finally {
      store.close();
    }
  });

  it('stays right when the version from before is put back and records into it', () => {
    const file = join(tempDir(), 'rapthooker.db');
    schema3Database(file);
    new Store(file).close();
    // What 0.3.0 runs for each reading (the installer puts it back if an update doesn't start).
    const db = new DatabaseSync(file);
    db.prepare(
      'INSERT OR IGNORE INTO readings (pill_id, ts, sg, temp, velocity, battery, rssi, x, y, z, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(PILL, T0 - DAY + 1000, 1.05, 21.5, -2.5, 86, -50, 400, -10, 925, 0);
    db.prepare(
      `INSERT INTO rollups (pill_id, bucket, n, sg, sg_n, sg_all, temp, velocity, velocity_n, battery, rssi, rssi_n, x, y, z)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pill_id, bucket) DO UPDATE SET
         n = n + 1, sg = sg + excluded.sg, sg_n = sg_n + excluded.sg_n, sg_all = sg_all + excluded.sg_all, temp = temp + excluded.temp,
         velocity = velocity + excluded.velocity, velocity_n = velocity_n + excluded.velocity_n,
         battery = battery + excluded.battery, rssi = rssi + excluded.rssi, rssi_n = rssi_n + excluded.rssi_n,
         x = x + excluded.x, y = y + excluded.y, z = z + excluded.z`,
    ).run(PILL, T0 - DAY, 1.05, 1, 1.05, 21.5, -2.5, 1, 86, -50, 1, 400, -10, 925);
    db.close();

    const store = new Store(file);
    try {
      const h = store.history(PILL, T0 - 2 * DAY, T0 - DAY + ROLLUP_MS, {
        maxPoints: 10,
        gapMs: DAY,
        offsets: { gravity: 0, temperature: 0 },
      });
      const i = h.ts.length - 1;
      expect(h.temperature[i]).toBeCloseTo((4 * 19.5 + 21.5) / 5, 6);
      expect(h.battery[i]).toBeCloseTo((4 * 90 + 86) / 5, 6);
      expect(h.gravity[i]).toBeCloseTo((3 * 1.06 + 1.05) / 4, 6);
    } finally {
      store.close();
    }
  });

  it('keeps a copy from before the upgrade, and only the newest few', () => {
    const data = tempDir();
    const file = join(data, 'rapthooker.db');
    schema3Database(file);
    // Older copies, named by a clock that was running ahead: the one about to be made must still be kept.
    ['01', '02', '03', '04'].forEach((day, i) => {
      const old = join(data, `pre-update-2030-01-${day}T00-00-00.db`);
      writeFileSync(old, 'old');
      utimesSync(old, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i));
    });
    const upgrades: [number, number][] = [];
    const store = new Store(file, {
      beforeUpgrade: (copyTo, from, to) => {
        upgrades.push([from, to]);
        return keepPreUpdateCopy(data, copyTo, new Date(2026, 9, 26, 1, 2, 3));
      },
    });
    // The write-ahead log the upgrade filled is emptied, and the hub is told to see about compacting.
    expect(statSync(`${file}-wal`).size).toBe(0);
    expect(store.getMeta(COMPACT_AFTER_UPGRADE_KEY)).toBe(String(MIGRATIONS.length));
    store.close();
    expect(upgrades).toEqual([[3, MIGRATIONS.length]]);
    const copies = readdirSync(data)
      .filter((f) => f.startsWith('pre-update-'))
      .sort();
    expect(copies).toEqual(['pre-update-2026-10-26T01-02-03.db', 'pre-update-2030-01-03T00-00-00.db', 'pre-update-2030-01-04T00-00-00.db']);
    expect(copies).toHaveLength(PRE_UPDATE_KEEP);
    // The copy is the data as it was, in one file that opens anywhere.
    const copy = join(data, 'pre-update-2026-10-26T01-02-03.db');
    expect(existsSync(`${copy}-wal`)).toBe(false);
    const old = new DatabaseSync(copy, { readOnly: true });
    expect(old.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    expect(old.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(old.prepare('SELECT COUNT(*) AS n FROM readings').get()).toEqual({ n: 3 });
    old.close();

    // It's listed with the backups, to download or restore.
    const other = new Store(join(data, 'other.db'));
    const m = new Maintenance(other, silent, {
      backupDir: join(data, 'backups'),
      backupTime: '03:15',
      keep: 7,
      rawRetentionDays: 0,
      dataDir: data,
    });
    expect(m.files()).toContainEqual(expect.objectContaining({ name: 'pre-update-2026-10-26T01-02-03.db', kind: 'pre-update' }));
    expect(m.fileByName('pre-update-2026-10-26T01-02-03.db')).toBe(copy);
    other.close();

    // Nothing to upgrade, or nothing yet to keep: no copy.
    let asked = 0;
    new Store(file, { beforeUpgrade: () => void asked++ }).close();
    const fresh = new Store(join(data, 'new.db'), { beforeUpgrade: () => void asked++ });
    expect(fresh.getMeta(COMPACT_AFTER_UPGRADE_KEY)).toBeNull();
    fresh.close();
    expect(asked).toBe(0);
  });

  it('leaves the database exactly as it was if the upgrade fails, without a copy left over', () => {
    const data = tempDir();
    const file = join(data, 'rapthooker.db');
    schema3Database(file);
    // Something in the way of migration 4's last steps, after it has already replaced the readings table.
    const db = new DatabaseSync(file);
    db.exec('ALTER TABLE rollups ADD COLUMN xyz_missing INTEGER');
    db.close();
    expect(() => new Store(file, { beforeUpgrade: (copyTo) => keepPreUpdateCopy(data, copyTo) })).toThrow(/xyz_missing/);
    expect(readdirSync(data).filter((f) => f.startsWith('pre-update-'))).toEqual([]);
    const after = new DatabaseSync(file, { readOnly: true });
    expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    expect(after.prepare('SELECT COUNT(*) AS n FROM readings').get()).toEqual({ n: 3 });
    // The original readings table, NOT NULL and all, and none of the new rollup columns.
    const notNull = (after.prepare('PRAGMA table_info(readings)').all() as { name: string; notnull: number }[]).find(
      (c) => c.name === 'sg',
    );
    expect(notNull?.notnull).toBe(1);
    expect((after.prepare('PRAGMA table_info(rollups)').all() as { name: string }[]).map((c) => c.name)).not.toContain('sg_missing');
    after.close();
  });

  it("leaves the database as it was if a copy can't be kept", () => {
    const data = tempDir();
    const file = join(data, 'rapthooker.db');
    schema3Database(file);
    expect(
      () =>
        new Store(file, {
          beforeUpgrade: (copyTo) => keepPreUpdateCopy(join(data, 'missing', 'folder'), copyTo),
        }),
    ).toThrow(/Couldn't keep a copy of the data before upgrading it/);
    const db = new DatabaseSync(file, { readOnly: true });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM readings').get()).toEqual({ n: 3 });
    db.close();
    expect(readdirSync(data).filter((f) => f.includes('partial'))).toEqual([]);
  });
});

describe('a database from a newer version', () => {
  it('is used as it is, unless that version said older ones no longer can', () => {
    const file = join(tempDir(), 'rapthooker.db');
    schema3Database(file);
    new Store(file).close();
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();

    const store = new Store(file);
    expect(store.schemaVersion).toBe(MIGRATIONS.length + 1);
    expect(store.countReadings()).toBe(3);
    store.setMeta(MIN_SCHEMA_KEY, String(MIGRATIONS.length + 1));
    store.close();

    expect(() => new Store(file)).toThrow(IncompatibleDatabaseError);
    expect(() => new Store(file)).toThrow(/newer version of RaptHooker/);
    const after = new DatabaseSync(file, { readOnly: true });
    expect(after.prepare('SELECT COUNT(*) AS n FROM readings').get()).toEqual({ n: 3 });
    after.close();
  });

  it("keeps a device's settings it doesn't understand, and records nothing for a kind it doesn't know", () => {
    const file = join(tempDir(), 'rapthooker.db');
    schema3Database(file);
    const store = new Store(file);
    const future = {
      kind: 'ispindel',
      name: 'Spindel',
      color: '#34d399',
      offsets: { gravity: 0, temperature: 0 },
      info: {},
      polynomial: '0.0001*tilt^2',
    };
    store.savePill('spindel', 'ISPINDEL:1234', future, T0);
    const now = T0 + DAY;
    const clock = new ClockGuard({ syncFile: null, maxWaitMs: 0, now: () => now, mono: () => now });
    const pills = new PillService(store, clock, silent, () => now);
    pills.load();
    try {
      // A pill's saved settings come back with everything they had, plus what's new.
      expect(pills.get(PILL)?.exclusions).toEqual([]);
      pills.update(PILL, { name: 'Hazy IPA (renamed)' });
      const saved = JSON.parse(store.listPillRows().find((r) => r.id === PILL)!.json) as Record<string, unknown>;
      expect(saved).toMatchObject({ kind: 'pill', name: 'Hazy IPA (renamed)', info: { firmware: '20250319_055542_b3788ba' } });

      expect(pills.get('spindel')?.kind).toBe('ispindel');
      pills.update('spindel', { name: 'Spindel 2' });
      const kept = JSON.parse(store.listPillRows().find((r) => r.id === 'spindel')!.json) as Record<string, unknown>;
      expect(kept).toMatchObject({ kind: 'ispindel', name: 'Spindel 2', polynomial: '0.0001*tilt^2' });
      for (const [companyId, data] of [
        [RAPT_COMPANY_ID, Buffer.from(CAPTURED.metricsFalling, 'hex')],
        [APPLE_COMPANY_ID, encodeRaptThermometer(18)],
      ] as const) {
        pills.handleAdvert({
          address: 'ISPINDEL:1234',
          rssi: -50,
          manufacturer: new Map([[companyId, data]]),
          at: now,
          mono: now,
          cached: false,
        });
      }
      expect(store.countReadings('spindel')).toBe(0);
      expect(pills.get('spindel')?.kind).toBe('ispindel');
    } finally {
      pills.stop();
      store.close();
    }
  });
});
