import { rmSync } from 'node:fs';
import { DatabaseSync, backup as sqliteBackup, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { DEFAULT_PILL_MODEL, rollingSlope, SMOOTHING_MS, smooth, tiltGravity } from '@rapthooker/shared';
import type { History, Offsets, PillModel, WebhookDelivery } from '@rapthooker/shared';

/**
 * A reading as decoded from a device, before calibration offsets. What a device doesn't measure is null (a RAPT
 * Thermometer has no gravity, battery or accelerometer).
 */
export interface RawReading {
  ts: number;
  sg: number | null;
  /** Every kind of device so far measures it (the column allows NULL, for one that doesn't). */
  temp: number;
  velocity: number | null;
  battery: number | null;
  rssi: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  /** FLAG_* bits. */
  flags: number;
}

/**
 * Schema versions, applied in order; the database's user_version says how many have run. People's brewing history is
 * in these tables: read docs/data-compatibility.md before adding one. Never edit, reorder or remove one once released.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE pills (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, json TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE readings (
    pill_id TEXT NOT NULL, ts INTEGER NOT NULL,
    sg REAL NOT NULL, temp REAL NOT NULL, velocity REAL, battery REAL NOT NULL, rssi INTEGER,
    x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
    PRIMARY KEY (pill_id, ts)
  ) WITHOUT ROWID;
  CREATE TABLE rollups (
    pill_id TEXT NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL,
    sg REAL NOT NULL, temp REAL NOT NULL, velocity REAL NOT NULL, velocity_n INTEGER NOT NULL,
    battery REAL NOT NULL, rssi REAL NOT NULL, rssi_n INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
    PRIMARY KEY (pill_id, bucket)
  ) WITHOUT ROWID;
  CREATE TABLE brews (
    id TEXT PRIMARY KEY, pill_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX brews_one_active ON brews (pill_id) WHERE ended_at IS NULL;
  CREATE INDEX brews_pill ON brews (pill_id, started_at);
  CREATE TABLE webhooks (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE webhook_state (
    webhook_id TEXT NOT NULL, pill_id TEXT NOT NULL, last_sent_at INTEGER, last_reading_ts INTEGER, last_ok INTEGER,
    failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER,
    PRIMARY KEY (webhook_id, pill_id)
  ) WITHOUT ROWID;
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT NOT NULL, pill_id TEXT, at INTEGER NOT NULL, ok INTEGER NOT NULL,
    status INTEGER, duration_ms INTEGER NOT NULL, method TEXT NOT NULL, url TEXT NOT NULL, request_body TEXT,
    response_body TEXT, error TEXT, test INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, id);
  CREATE INDEX webhook_deliveries_at ON webhook_deliveries (at);
  CREATE TABLE alert_rules (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE alert_state (
    rule_id TEXT NOT NULL, pill_id TEXT NOT NULL, active INTEGER NOT NULL, last_fired_at INTEGER,
    PRIMARY KEY (rule_id, pill_id)
  ) WITHOUT ROWID;
  CREATE TABLE alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id TEXT NOT NULL, rule_name TEXT NOT NULL, pill_id TEXT NOT NULL,
    at INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, value REAL
  );
  CREATE INDEX alert_events_at ON alert_events (at);
  CREATE TABLE push_subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, user TEXT NOT NULL, created_at INTEGER NOT NULL);
  `,
  // v2: implausible-reading flags (bit 0: the pill didn't look like it was floating), with rollups averaging only
  // plausible gravity; brew events; API tokens; notification channels.
  `
  ALTER TABLE readings ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
  UPDATE readings SET flags = 1 WHERE sg < 0.98 OR sg > 1.2;
  ALTER TABLE rollups ADD COLUMN sg_all REAL NOT NULL DEFAULT 0;
  ALTER TABLE rollups ADD COLUMN sg_n INTEGER NOT NULL DEFAULT 0;
  UPDATE rollups SET sg_all = sg, sg_n = n;
  UPDATE rollups SET
    sg = (SELECT TOTAL(r.sg) FROM readings r WHERE r.pill_id = rollups.pill_id AND r.ts >= rollups.bucket AND r.ts < rollups.bucket + 900000 AND r.flags & 1 = 0),
    sg_n = (SELECT COUNT(*) FROM readings r WHERE r.pill_id = rollups.pill_id AND r.ts >= rollups.bucket AND r.ts < rollups.bucket + 900000 AND r.flags & 1 = 0)
  WHERE EXISTS (SELECT 1 FROM readings r WHERE r.pill_id = rollups.pill_id AND r.ts >= rollups.bucket AND r.ts < rollups.bucket + 900000);
  CREATE TABLE brew_events (id TEXT PRIMARY KEY, brew_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
  CREATE INDEX brew_events_brew ON brew_events (brew_id, at);
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_used_at INTEGER
  );
  CREATE TABLE channels (
    id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL, last_at INTEGER, last_ok INTEGER, last_error TEXT
  );
  `,
  // v3: webhooks remember the gravity and temperature they last sent (for change thresholds) and how far catch-up
  // has got (readings up to cursor_ts are dealt with).
  `
  ALTER TABLE webhook_state ADD COLUMN last_gravity REAL;
  ALTER TABLE webhook_state ADD COLUMN last_temp REAL;
  ALTER TABLE webhook_state ADD COLUMN cursor_ts INTEGER;
  `,
  // v4: what a device doesn't measure is NULL rather than 0 (a RAPT Thermometer has no gravity, battery or
  // accelerometer, and other kinds of device will measure other things). SQLite can't drop NOT NULL, so readings is
  // copied, every row, into a new table. Rollups count, for each measurement, the readings that didn't have it (a
  // bucket's average is sum / (n - missing)): counting what's missing rather than what's there keeps a bucket right
  // when an older version (put back after an update) adds a pill's reading, which has everything, without knowing
  // these columns. Development builds stored a thermometer's readings as zeros with flag 2: those become NULLs.
  `
  CREATE TABLE readings_v4 (
    pill_id TEXT NOT NULL, ts INTEGER NOT NULL,
    sg REAL, temp REAL, velocity REAL, battery REAL, rssi INTEGER, x REAL, y REAL, z REAL,
    flags INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pill_id, ts)
  ) WITHOUT ROWID;
  INSERT INTO readings_v4 (pill_id, ts, sg, temp, velocity, battery, rssi, x, y, z, flags)
    SELECT pill_id, ts,
      CASE WHEN flags & 2 THEN NULL ELSE sg END, temp, velocity, CASE WHEN flags & 2 THEN NULL ELSE battery END, rssi,
      CASE WHEN flags & 2 THEN NULL ELSE x END, CASE WHEN flags & 2 THEN NULL ELSE y END, CASE WHEN flags & 2 THEN NULL ELSE z END,
      flags & ~2
    FROM readings;
  DROP TABLE readings;
  ALTER TABLE readings_v4 RENAME TO readings;
  ALTER TABLE rollups ADD COLUMN sg_missing INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rollups ADD COLUMN temp_missing INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rollups ADD COLUMN battery_missing INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rollups ADD COLUMN xyz_missing INTEGER NOT NULL DEFAULT 0;
  UPDATE rollups SET sg_all = 0, sg_missing = n, battery = 0, battery_missing = n, x = 0, y = 0, z = 0, xyz_missing = n
    WHERE pill_id IN (SELECT id FROM pills WHERE CASE WHEN json_valid(json) THEN json_extract(json, '$.kind') END = 'thermometer');
  `,
];

/**
 * A meta key a migration sets when versions of RaptHooker that don't know it can't use the database safely any more:
 * the lowest schema version (MIGRATIONS.length) that can. Older versions then refuse to open it rather than damage it.
 */
export const MIN_SCHEMA_KEY = 'minSchema';

/** Bits in readings.flags. (2 was a development build's; don't use it.) */
export const FLAG_IMPLAUSIBLE = 1;

export const ROLLUP_MS = 15 * 60_000;
const DELIVERIES_KEPT = 200;

type Row = Record<string, SQLInputValue>;

export interface JsonRow {
  id: string;
  json: string;
  created_at: number;
}

export interface BrewRow {
  id: string;
  pill_id: string;
  started_at: number;
  ended_at: number | null;
  json: string;
  created_at: number;
}

export interface BrewEventRow {
  id: string;
  brew_id: string;
  at: number;
  kind: string;
  text: string;
}

export interface WebhookStateRow {
  webhook_id: string;
  pill_id: string;
  last_sent_at: number | null;
  last_reading_ts: number | null;
  last_ok: number | null;
  failures: number;
  retry_at: number | null;
  /** SG and °C of the last reading sent successfully. */
  last_gravity: number | null;
  last_temp: number | null;
  /** Catch-up never replays readings up to this time (skipped, or while switched off or paused). */
  cursor_ts: number | null;
}

/** A 15-minute average standing in for raw readings that have been pruned (see Store.prunedRollups). */
export interface PrunedRollup {
  bucket: number;
  /** Plausible readings in the bucket. */
  n: number;
  sg: number;
  temp: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
}

export interface Aggregate {
  n: number;
  firstTs: number | null;
  lastTs: number | null;
  tempMin: number | null;
  tempMax: number | null;
  tempSum: number;
}

/** Angle from vertical, degrees, from the accelerometer (the pill's long axis is z). */
export function tiltOf(x: number | null, y: number | null, z: number | null): number | null {
  if (x === null || y === null || z === null) return null;
  const g = Math.sqrt(x * x + y * y + z * z);
  if (!(g > 0)) return null;
  return (Math.acos(Math.min(1, Math.abs(z) / g)) * 180) / Math.PI;
}

/** The database was upgraded by a newer version of RaptHooker that said older ones can't use it any more. */
export class IncompatibleDatabaseError extends Error {}

export interface StoreOptions {
  /**
   * Called just before an existing database is upgraded, to keep a copy of it as it was: `copyTo` writes one. If it
   * throws, the database is left as it is and opening it fails. It returns the copy's path, which is deleted again if
   * the upgrade then fails (the database is as it was). Without it (tests, or a backup being restored, which is a copy
   * already) no copy is made.
   */
  beforeUpgrade?: (copyTo: (file: string) => void, from: number, to: number) => string | void;
}

/**
 * A meta key set when an update has upgraded the database: a rebuilt table leaves unused space in the file (and in
 * every backup), so the hub checks whether to compact it soon after (see SystemService.housekeeping).
 */
export const COMPACT_AFTER_UPGRADE_KEY = 'compactAfterUpgrade';

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export class Store {
  readonly db: DatabaseSync;
  private readonly insertReadingStmt: StatementSync;
  private readonly upsertRollupStmt: StatementSync;
  private depth = 0;

  constructor(
    readonly path: string,
    private readonly opts: StoreOptions = {},
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;');
    try {
      this.migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
    this.insertReadingStmt = this.db.prepare(
      'INSERT OR IGNORE INTO readings (pill_id, ts, sg, temp, velocity, battery, rssi, x, y, z, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    // Each measurement is a sum, with a count of the readings that didn't have it (see migration v4). sg/sg_n only
    // count plausible readings; sg_all covers every reading with a gravity, for buckets where none were plausible.
    this.upsertRollupStmt = this.db.prepare(`
      INSERT INTO rollups (pill_id, bucket, n, sg, sg_n, sg_all, sg_missing, temp, temp_missing, velocity, velocity_n, battery,
        battery_missing, rssi, rssi_n, x, y, z, xyz_missing)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (pill_id, bucket) DO UPDATE SET
        n = n + 1, sg = sg + excluded.sg, sg_n = sg_n + excluded.sg_n, sg_all = sg_all + excluded.sg_all,
        sg_missing = sg_missing + excluded.sg_missing, temp = temp + excluded.temp, temp_missing = temp_missing + excluded.temp_missing,
        velocity = velocity + excluded.velocity, velocity_n = velocity_n + excluded.velocity_n,
        battery = battery + excluded.battery, battery_missing = battery_missing + excluded.battery_missing,
        rssi = rssi + excluded.rssi, rssi_n = rssi_n + excluded.rssi_n,
        x = x + excluded.x, y = y + excluded.y, z = z + excluded.z, xyz_missing = xyz_missing + excluded.xyz_missing`);
  }

  get schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  private migrate(): void {
    const from = this.schemaVersion;
    if (from > MIGRATIONS.length) {
      // Upgraded by a newer version (since put back, say). Its changes keep older versions working unless it says not.
      const min = Number(this.getMeta(MIN_SCHEMA_KEY) ?? 0);
      if (min > MIGRATIONS.length) {
        throw new IncompatibleDatabaseError(
          `The database was upgraded by a newer version of RaptHooker (schema ${from}) that this one (schema ${MIGRATIONS.length}) ` +
            "can't use safely. Update RaptHooker again, or restore the copy saved before that update.",
        );
      }
      return;
    }
    let copy: string | void = undefined;
    if (from > 0 && from < MIGRATIONS.length && this.opts.beforeUpgrade) {
      copy = this.opts.beforeUpgrade((file) => this.copyTo(file), from, MIGRATIONS.length);
    }
    if (from === MIGRATIONS.length) return;
    // All in one transaction: if any of it fails, the database is exactly as it was.
    try {
      this.transaction(() => {
        for (let v = from; v < MIGRATIONS.length; v++) {
          this.db.exec(MIGRATIONS[v]!);
          this.db.exec(`PRAGMA user_version = ${v + 1}`);
        }
        if (from > 0) this.setMeta(COMPACT_AFTER_UPGRADE_KEY, String(MIGRATIONS.length));
      });
    } catch (err) {
      if (copy) rmSync(copy, { force: true });
      throw err;
    }
    // The write-ahead log grew with the upgrade: give the space back.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** A consistent, self-contained copy of the database in `file` (which mustn't exist yet). */
  private copyTo(file: string): void {
    this.db.exec(`VACUUM INTO ${sqlString(file)}`);
    const copy = new DatabaseSync(file);
    try {
      copy.exec('PRAGMA journal_mode = DELETE');
    } finally {
      copy.close();
    }
  }

  /** Runs fn in a transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  async backupTo(file: string): Promise<void> {
    await sqliteBackup(this.db, file);
  }

  // Meta

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  // Pills

  listPillRows(): (JsonRow & { address: string })[] {
    return this.db.prepare('SELECT id, address, json, created_at FROM pills ORDER BY created_at').all() as unknown as (JsonRow & {
      address: string;
    })[];
  }

  savePill(id: string, address: string, json: unknown, createdAt: number): void {
    this.db
      .prepare('INSERT INTO pills (id, address, json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json')
      .run(id, address, JSON.stringify(json), createdAt);
  }

  /** Removes a pill with all its readings, brews and webhook/alert state. */
  deletePill(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM brew_events WHERE brew_id IN (SELECT id FROM brews WHERE pill_id = ?)').run(id);
      for (const table of ['readings', 'rollups', 'brews', 'webhook_state', 'alert_state']) {
        this.db.prepare(`DELETE FROM ${table} WHERE pill_id = ?`).run(id);
      }
      this.db.prepare('DELETE FROM pills WHERE id = ?').run(id);
    });
  }

  // Readings

  addReading(pillId: string, r: RawReading): boolean {
    return this.transaction(() => {
      const res = this.insertReadingStmt.run(pillId, r.ts, r.sg, r.temp, r.velocity, r.battery, r.rssi, r.x, r.y, r.z, r.flags);
      if (res.changes === 0) return false;
      const bucket = r.ts - (r.ts % ROLLUP_MS);
      const plausible = (r.flags & FLAG_IMPLAUSIBLE) === 0;
      const sum = (v: number | null): [number, number] => (v === null ? [0, 0] : [v, 1]);
      const missing = (v: number | null): [number, number] => (v === null ? [0, 1] : [v, 0]);
      const xyz = r.x !== null && r.y !== null && r.z !== null;
      this.upsertRollupStmt.run(
        pillId,
        bucket,
        ...sum(plausible ? r.sg : null),
        ...missing(r.sg),
        ...missing(r.temp),
        ...sum(r.velocity),
        ...missing(r.battery),
        ...sum(r.rssi),
        xyz ? r.x : 0,
        xyz ? r.y : 0,
        xyz ? r.z : 0,
        xyz ? 0 : 1,
      );
      return true;
    });
  }

  /** Changes a reading's flags (keeping its rollup in step). */
  setReadingFlags(pillId: string, ts: number, flags: number): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT sg, flags FROM readings WHERE pill_id = ? AND ts = ?').get(pillId, ts) as
        { sg: number | null; flags: number } | undefined;
      if (!row || row.flags === flags) return;
      this.db.prepare('UPDATE readings SET flags = ? WHERE pill_id = ? AND ts = ?').run(flags, pillId, ts);
      const was = (row.flags & FLAG_IMPLAUSIBLE) === 0;
      const now = (flags & FLAG_IMPLAUSIBLE) === 0;
      if (was === now || row.sg === null) return;
      const sign = now ? 1 : -1;
      this.db
        .prepare('UPDATE rollups SET sg = sg + ?, sg_n = sg_n + ? WHERE pill_id = ? AND bucket = ?')
        .run(sign * row.sg, sign, pillId, ts - (ts % ROLLUP_MS));
    });
  }

  latestReadings(pillId: string, limit: number): RawReading[] {
    return this.db
      .prepare('SELECT ts, sg, temp, velocity, battery, rssi, x, y, z, flags FROM readings WHERE pill_id = ? ORDER BY ts DESC LIMIT ?')
      .all(pillId, limit) as unknown as RawReading[];
  }

  readingsFrom(pillId: string, from: number, limit: number): RawReading[] {
    return this.db
      .prepare(
        'SELECT ts, sg, temp, velocity, battery, rssi, x, y, z, flags FROM readings WHERE pill_id = ? AND ts >= ? ORDER BY ts LIMIT ?',
      )
      .all(pillId, from, limit) as unknown as RawReading[];
  }

  lastReadingBefore(pillId: string, ts: number): RawReading | null {
    return (
      (this.db
        .prepare(
          'SELECT ts, sg, temp, velocity, battery, rssi, x, y, z, flags FROM readings WHERE pill_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1',
        )
        .get(pillId, ts) as unknown as RawReading | undefined) ?? null
    );
  }

  lastPlausibleBefore(pillId: string, ts: number): RawReading | null {
    return (
      (this.db
        .prepare(
          'SELECT ts, sg, temp, velocity, battery, rssi, x, y, z, flags FROM readings WHERE pill_id = ? AND ts <= ? AND flags & 1 = 0 AND sg IS NOT NULL ORDER BY ts DESC LIMIT 1',
        )
        .get(pillId, ts) as unknown as RawReading | undefined) ?? null
    );
  }

  firstReadingTs(pillId: string): number | null {
    return (this.db.prepare('SELECT MIN(ts) AS ts FROM readings WHERE pill_id = ?').get(pillId) as { ts: number | null }).ts;
  }

  *iterateReadings(pillId: string, from: number, to: number): Generator<RawReading> {
    const stmt = this.db.prepare(
      'SELECT ts, sg, temp, velocity, battery, rssi, x, y, z, flags FROM readings WHERE pill_id = ? AND ts BETWEEN ? AND ? ORDER BY ts',
    );
    for (const row of stmt.iterate(pillId, from, to)) yield row as unknown as RawReading;
  }

  aggregate(pillId: string, from: number, to: number): Aggregate {
    const row = this.db
      .prepare(
        'SELECT COUNT(temp) AS n, MIN(ts) AS firstTs, MAX(ts) AS lastTs, MIN(temp) AS tempMin, MAX(temp) AS tempMax, TOTAL(temp) AS tempSum FROM readings WHERE pill_id = ? AND ts BETWEEN ? AND ? AND flags & 1 = 0',
      )
      .get(pillId, from, to) as unknown as Aggregate;
    return row;
  }

  countReadings(pillId?: string, since = 0): number {
    if (pillId === undefined) return (this.db.prepare('SELECT COUNT(*) AS n FROM readings').get() as { n: number }).n;
    return (this.db.prepare('SELECT COUNT(*) AS n FROM readings WHERE pill_id = ? AND ts >= ?').get(pillId, since) as { n: number }).n;
  }

  /** Lowest and highest raw gravity of the plausible readings in a window. */
  sgRange(pillId: string, from: number, to: number): { n: number; min: number | null; max: number | null; firstTs: number | null } {
    return this.db
      .prepare(
        'SELECT COUNT(sg) AS n, MIN(sg) AS min, MAX(sg) AS max, MIN(CASE WHEN sg IS NOT NULL THEN ts END) AS firstTs FROM readings WHERE pill_id = ? AND ts BETWEEN ? AND ? AND flags & 1 = 0',
      )
      .get(pillId, from, to) as unknown as { n: number; min: number | null; max: number | null; firstTs: number | null };
  }

  pruneRaw(before: number): number {
    return Number(this.db.prepare('DELETE FROM readings WHERE ts < ?').run(before).changes);
  }

  /**
   * The 15-minute averages for [from, to), oldest first, where the raw readings are gone: only buckets that end before
   * the pill's oldest remaining raw reading (so nothing is counted twice). `sg` averages the plausible readings only,
   * `n` counts them.
   */
  prunedRollups(pillId: string, from: number, to: number): PrunedRollup[] {
    const firstRaw = this.firstReadingTs(pillId);
    const until = Math.min(to, firstRaw ?? to);
    if (until <= from) return [];
    return this.db
      .prepare(
        `SELECT bucket, sg_n AS n, sg / sg_n AS sg, CASE WHEN n > temp_missing THEN temp / (n - temp_missing) END AS temp,
                CASE WHEN n > xyz_missing THEN x / (n - xyz_missing) END AS x, CASE WHEN n > xyz_missing THEN y / (n - xyz_missing) END AS y,
                CASE WHEN n > xyz_missing THEN z / (n - xyz_missing) END AS z
         FROM rollups WHERE pill_id = ? AND bucket >= ? AND bucket + ${ROLLUP_MS} <= ? AND sg_n > 0 ORDER BY bucket`,
      )
      .all(pillId, from, until) as unknown as PrunedRollup[];
  }

  /**
   * Chart history: raw readings when they fit in `maxPoints`, otherwise averages over buckets (from the 15-minute
   * rollups for long ranges). Gaps longer than `gapMs` (e.g. the hub was off) become a row of nulls so charts break
   * the line there. The pill's model decides where the gravity and velocity come from. Whatever a device doesn't
   * measure (a thermometer's gravity, battery and tilt) is null.
   */
  history(
    pillId: string,
    from: number,
    to: number,
    opts: { maxPoints: number; gapMs: number; offsets: Offsets; model?: PillModel; rawFrom?: number },
  ): History {
    const model = opts.model ?? DEFAULT_PILL_MODEL;
    const span = Math.max(1, to - from);
    let bucket = Math.ceil(span / Math.max(10, opts.maxPoints));
    // Raw readings older than the retention cutoff are gone; their 15-minute averages remain.
    if (opts.rawFrom !== undefined && from < opts.rawFrom) bucket = Math.max(bucket, ROLLUP_MS);
    // RaptHooker's velocity and smoothing look back in time, so fetch that much before the range too.
    const velocityMs = model.velocitySource === 'computed' ? model.velocityHours * 3_600_000 : 0;
    const lookback = Math.max(velocityMs, SMOOTHING_MS[model.smoothing]);
    const qFrom = from - lookback;
    type P = {
      ts: number;
      sg: number | null;
      temp: number | null;
      velocity: number | null;
      battery: number | null;
      rssi: number | null;
      x: number | null;
      y: number | null;
      z: number | null;
      flags: number;
    };
    let rows: P[];

    if (bucket <= 60_000) {
      bucket = 0;
      rows = this.db
        .prepare(
          'SELECT ts, sg, temp, velocity, battery, rssi, x, y, z, flags FROM readings WHERE pill_id = ? AND ts BETWEEN ? AND ? ORDER BY ts LIMIT ?',
        )
        .all(pillId, qFrom, to, opts.maxPoints * 4 + Math.ceil(lookback / 60_000)) as unknown as P[];
    } else if (bucket < ROLLUP_MS) {
      rows = this.db
        .prepare(
          `SELECT CAST(AVG(ts) AS INTEGER) AS ts, COALESCE(AVG(CASE WHEN flags & 1 = 0 THEN sg END), AVG(sg)) AS sg, AVG(temp) AS temp,
                  AVG(velocity) AS velocity, AVG(battery) AS battery, AVG(rssi) AS rssi, AVG(x) AS x, AVG(y) AS y, AVG(z) AS z,
                  MIN(flags & 1) AS flags
           FROM readings WHERE pill_id = ? AND ts BETWEEN ? AND ? GROUP BY ts / ${Math.floor(bucket)} ORDER BY 1`,
        )
        .all(pillId, qFrom, to) as unknown as P[];
    } else {
      bucket = Math.ceil(bucket / ROLLUP_MS) * ROLLUP_MS;
      rows = this.db
        .prepare(
          `SELECT CAST(TOTAL(n * bucket) / TOTAL(n) AS INTEGER) + ${ROLLUP_MS / 2} AS ts,
                  CASE WHEN TOTAL(sg_n) > 0 THEN TOTAL(sg) / TOTAL(sg_n)
                       WHEN TOTAL(n) > TOTAL(sg_missing) THEN TOTAL(sg_all) / (TOTAL(n) - TOTAL(sg_missing)) END AS sg,
                  CASE WHEN TOTAL(n) > TOTAL(temp_missing) THEN TOTAL(temp) / (TOTAL(n) - TOTAL(temp_missing)) END AS temp,
                  CASE WHEN TOTAL(velocity_n) > 0 THEN TOTAL(velocity) / TOTAL(velocity_n) END AS velocity,
                  CASE WHEN TOTAL(n) > TOTAL(battery_missing) THEN TOTAL(battery) / (TOTAL(n) - TOTAL(battery_missing)) END AS battery,
                  CASE WHEN TOTAL(rssi_n) > 0 THEN TOTAL(rssi) / TOTAL(rssi_n) END AS rssi,
                  CASE WHEN TOTAL(n) > TOTAL(xyz_missing) THEN TOTAL(x) / (TOTAL(n) - TOTAL(xyz_missing)) END AS x,
                  CASE WHEN TOTAL(n) > TOTAL(xyz_missing) THEN TOTAL(y) / (TOTAL(n) - TOTAL(xyz_missing)) END AS y,
                  CASE WHEN TOTAL(n) > TOTAL(xyz_missing) THEN TOTAL(z) / (TOTAL(n) - TOTAL(xyz_missing)) END AS z,
                  CASE WHEN TOTAL(sg_n) > 0 OR TOTAL(n) = TOTAL(sg_missing) THEN 0 ELSE 1 END AS flags
           FROM rollups WHERE pill_id = ? AND bucket BETWEEN ? AND ? GROUP BY bucket / ${Math.floor(bucket)} ORDER BY 1`,
        )
        .all(pillId, qFrom - (qFrom % ROLLUP_MS), to) as unknown as P[];
    }

    // Model the whole fetched span, then keep the requested range.
    const ts = rows.map((r) => r.ts);
    const implausible = rows.map((r) => (r.flags & FLAG_IMPLAUSIBLE) !== 0);
    const tilt = rows.map((r) => tiltOf(r.x, r.y, r.z));
    const pillGravity = rows.map((r) => (r.sg === null ? null : r.sg + opts.offsets.gravity));
    let gravity = rows.map((r, i) => {
      const fromTilt = tiltGravity(model, tilt[i]!);
      return fromTilt === null ? pillGravity[i]! : fromTilt + opts.offsets.gravity;
    });
    let velocity = rows.map((r) => r.velocity);
    if (velocityMs > 0) {
      const usable = gravity.map((g, i) => (implausible[i] ? null : g));
      velocity = rollingSlope(ts, usable, velocityMs);
    }
    if (model.smoothing !== 'off' && bucket < SMOOTHING_MS[model.smoothing]) {
      const smoothed = smooth(
        ts,
        gravity.map((g, i) => (implausible[i] ? null : g)),
        SMOOTHING_MS[model.smoothing],
      );
      gravity = gravity.map((g, i) => (implausible[i] ? g : (smoothed[i] ?? g)));
    }
    const differs = model.gravitySource === 'tilt' || model.smoothing !== 'off';

    const out: History = {
      pillId,
      from,
      to,
      bucketMs: bucket,
      ts: [],
      gravity: [],
      temperature: [],
      velocity: [],
      battery: [],
      rssi: [],
      tilt: [],
      implausible: [],
      ...(differs ? { pillGravity: [] } : {}),
      ...(velocityMs > 0 ? { pillVelocity: [] } : {}),
    };
    const gap = Math.max(opts.gapMs, bucket * 2.5);
    let prev: number | null = null;
    const pushNull = (t: number) => {
      out.ts.push(t);
      out.gravity.push(null);
      out.temperature.push(null);
      out.velocity.push(null);
      out.battery.push(null);
      out.rssi.push(null);
      out.tilt.push(null);
      out.implausible.push(null);
      out.pillGravity?.push(null);
      out.pillVelocity?.push(null);
    };
    rows.forEach((r, i) => {
      if (r.ts < from - (bucket > 0 ? bucket : 0)) return;
      if (prev !== null && r.ts - prev > gap) pushNull(Math.round((prev + r.ts) / 2));
      prev = r.ts;
      out.ts.push(r.ts);
      out.temperature.push(r.temp === null ? null : r.temp + opts.offsets.temperature);
      out.rssi.push(r.rssi === null ? null : Math.round(r.rssi));
      out.gravity.push(gravity[i]!);
      out.velocity.push(velocity[i] ?? null);
      out.battery.push(r.battery);
      out.tilt.push(tilt[i]!);
      out.implausible.push(implausible[i]!);
      out.pillGravity?.push(pillGravity[i]!);
      out.pillVelocity?.push(r.velocity);
    });
    return out;
  }

  // Brews

  listBrewRows(pillId?: string): BrewRow[] {
    return (pillId
      ? this.db.prepare('SELECT * FROM brews WHERE pill_id = ? ORDER BY started_at DESC').all(pillId)
      : this.db.prepare('SELECT * FROM brews ORDER BY started_at DESC').all()) as unknown as BrewRow[];
  }

  getBrewRow(id: string): BrewRow | null {
    return (this.db.prepare('SELECT * FROM brews WHERE id = ?').get(id) as unknown as BrewRow | undefined) ?? null;
  }

  activeBrewRows(): BrewRow[] {
    return this.db.prepare('SELECT * FROM brews WHERE ended_at IS NULL').all() as unknown as BrewRow[];
  }

  saveBrew(row: BrewRow): void {
    this.db
      .prepare(
        `INSERT INTO brews (id, pill_id, started_at, ended_at, json, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at, json = excluded.json`,
      )
      .run(row.id, row.pill_id, row.started_at, row.ended_at, row.json, row.created_at);
  }

  /** Removes a brew and its events. */
  deleteBrew(id: string): boolean {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM brew_events WHERE brew_id = ?').run(id);
      return Number(this.db.prepare('DELETE FROM brews WHERE id = ?').run(id).changes) > 0;
    });
  }

  listBrewEvents(brewId: string): BrewEventRow[] {
    return this.db
      .prepare('SELECT id, brew_id, at, kind, text FROM brew_events WHERE brew_id = ? ORDER BY at, id')
      .all(brewId) as unknown as BrewEventRow[];
  }

  getBrewEvent(id: string): BrewEventRow | null {
    const row = this.db.prepare('SELECT id, brew_id, at, kind, text FROM brew_events WHERE id = ?').get(id);
    return (row as unknown as BrewEventRow | undefined) ?? null;
  }

  saveBrewEvent(row: BrewEventRow): void {
    this.db
      .prepare(
        `INSERT INTO brew_events (id, brew_id, at, kind, text) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET at = excluded.at, kind = excluded.kind, text = excluded.text`,
      )
      .run(row.id, row.brew_id, row.at, row.kind, row.text);
  }

  deleteBrewEvent(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM brew_events WHERE id = ?').run(id).changes) > 0;
  }

  // Webhooks

  listWebhookRows(): (JsonRow & { updated_at: number })[] {
    return this.db.prepare('SELECT id, json, created_at, updated_at FROM webhooks ORDER BY created_at').all() as unknown as (JsonRow & {
      updated_at: number;
    })[];
  }

  saveWebhook(id: string, json: unknown, createdAt: number, updatedAt: number): void {
    this.db
      .prepare(
        'INSERT INTO webhooks (id, json, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
      )
      .run(id, JSON.stringify(json), createdAt, updatedAt);
  }

  deleteWebhook(id: string): boolean {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM webhook_state WHERE webhook_id = ?').run(id);
      this.db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(id);
      return Number(this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes) > 0;
    });
  }

  webhookStates(webhookId?: string): WebhookStateRow[] {
    return (webhookId
      ? this.db.prepare('SELECT * FROM webhook_state WHERE webhook_id = ?').all(webhookId)
      : this.db.prepare('SELECT * FROM webhook_state').all()) as unknown as WebhookStateRow[];
  }

  saveWebhookState(s: WebhookStateRow): void {
    this.db
      .prepare(
        `INSERT INTO webhook_state (webhook_id, pill_id, last_sent_at, last_reading_ts, last_ok, failures, retry_at, last_gravity, last_temp, cursor_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (webhook_id, pill_id) DO UPDATE SET last_sent_at = excluded.last_sent_at, last_reading_ts = excluded.last_reading_ts,
           last_ok = excluded.last_ok, failures = excluded.failures, retry_at = excluded.retry_at, last_gravity = excluded.last_gravity,
           last_temp = excluded.last_temp, cursor_ts = excluded.cursor_ts`,
      )
      .run(
        s.webhook_id,
        s.pill_id,
        s.last_sent_at,
        s.last_reading_ts,
        s.last_ok,
        s.failures,
        s.retry_at,
        s.last_gravity ?? null,
        s.last_temp ?? null,
        s.cursor_ts ?? null,
      );
  }

  addDelivery(d: Omit<WebhookDelivery, 'id'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO webhook_deliveries (webhook_id, pill_id, at, ok, status, duration_ms, method, url, request_body, response_body, error, test)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.webhookId,
        d.pillId,
        d.at,
        d.ok ? 1 : 0,
        d.status,
        d.durationMs,
        d.method,
        d.url,
        d.requestBody,
        d.responseBody,
        d.error,
        d.test ? 1 : 0,
      );
    this.db
      .prepare(
        'DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id <= (SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
      )
      .run(d.webhookId, d.webhookId, DELIVERIES_KEPT);
    return Number(res.lastInsertRowid);
  }

  listDeliveries(webhookId: string, limit: number): WebhookDelivery[] {
    const rows = this.db
      .prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?')
      .all(webhookId, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      webhookId: String(r.webhook_id),
      pillId: (r.pill_id as string | null) ?? null,
      at: Number(r.at),
      ok: r.ok === 1,
      status: (r.status as number | null) ?? null,
      durationMs: Number(r.duration_ms),
      method: String(r.method),
      url: String(r.url),
      requestBody: (r.request_body as string | null) ?? null,
      responseBody: (r.response_body as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      test: r.test === 1,
    }));
  }

  deliveryCounts(webhookId: string, since: number): { sent: number; failed: number } {
    const row = this.db
      .prepare('SELECT COUNT(*) AS sent, TOTAL(ok = 0) AS failed FROM webhook_deliveries WHERE webhook_id = ? AND at >= ? AND test = 0')
      .get(webhookId, since) as { sent: number; failed: number };
    return { sent: row.sent, failed: Math.round(row.failed) };
  }

  // Alerts

  listAlertRuleRows(): JsonRow[] {
    return this.db.prepare('SELECT id, json, created_at FROM alert_rules ORDER BY created_at').all() as unknown as JsonRow[];
  }

  saveAlertRule(id: string, json: unknown, createdAt: number): void {
    this.db
      .prepare('INSERT INTO alert_rules (id, json, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json')
      .run(id, JSON.stringify(json), createdAt);
  }

  deleteAlertRule(id: string): boolean {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM alert_state WHERE rule_id = ?').run(id);
      return Number(this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id).changes) > 0;
    });
  }

  alertStates(): { rule_id: string; pill_id: string; active: number; last_fired_at: number | null }[] {
    return this.db.prepare('SELECT * FROM alert_state').all() as unknown as {
      rule_id: string;
      pill_id: string;
      active: number;
      last_fired_at: number | null;
    }[];
  }

  /** `quiet`: active, but the cooldown kept it from being announced (so its end isn't announced either). */
  saveAlertState(ruleId: string, pillId: string, active: boolean, lastFiredAt: number | null, quiet = false): void {
    this.db
      .prepare(
        `INSERT INTO alert_state (rule_id, pill_id, active, last_fired_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (rule_id, pill_id) DO UPDATE SET active = excluded.active, last_fired_at = excluded.last_fired_at`,
      )
      .run(ruleId, pillId, active ? (quiet ? 2 : 1) : 0, lastFiredAt);
  }

  addAlertEvent(e: {
    ruleId: string;
    ruleName: string;
    pillId: string;
    at: number;
    kind: string;
    message: string;
    value: number | null;
  }): number {
    const res = this.db
      .prepare('INSERT INTO alert_events (rule_id, rule_name, pill_id, at, kind, message, value) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.ruleId, e.ruleName, e.pillId, e.at, e.kind, e.message, e.value);
    this.db.prepare('DELETE FROM alert_events WHERE id <= (SELECT id FROM alert_events ORDER BY id DESC LIMIT 1 OFFSET 500)').run();
    return Number(res.lastInsertRowid);
  }

  listAlertEvents(limit: number): Row[] {
    return this.db.prepare('SELECT * FROM alert_events ORDER BY id DESC LIMIT ?').all(limit) as Row[];
  }

  // Push

  savePushSub(endpoint: string, json: string, user: string, at: number): void {
    this.db
      .prepare(
        'INSERT INTO push_subs (endpoint, json, user, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET json = excluded.json',
      )
      .run(endpoint, json, user, at);
  }

  deletePushSub(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
  }

  listPushSubs(): { endpoint: string; json: string }[] {
    return this.db.prepare('SELECT endpoint, json FROM push_subs').all() as unknown as { endpoint: string; json: string }[];
  }
}
