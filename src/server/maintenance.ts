import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BackupFile, BackupOverview, BackupSettings, BackupTargetStatus, Brew, Pill } from '@rapthooker/shared';
import type { Store } from './db.js';
import type { Logger } from './log.js';
import {
  BACKUP_RE,
  PRE_RESTORE_RE,
  PRE_UPDATE_RE,
  WEEK_RE,
  copyFolder,
  copyInto,
  localDate,
  pruneFiles,
  snapshot,
} from './backup/files.js';
import { USB_DIR, usbErrorText, usbMounted, type UsbCheck } from './backup/usb.js';
import { S3Client, normalizePrefix, pruneS3Backups, pruneS3Csv } from './backup/s3.js';
import { writeWeeklyCsv } from './backup/csv.js';
import { restartForRestore } from './restore.js';

/** Backups kept on the USB stick and in S3. */
export const OFFSITE_KEEP = 30;
/** Weekly CSV folders kept everywhere. */
export const CSV_KEEP_WEEKS = 8;

const DAY = 86_400_000;

export interface MaintenanceOptions {
  /** Where the daily backups go. Empty: <dataDir>/backups. */
  backupDir: string;
  backupTime: string;
  keep: number;
  rawRetentionDays: number;
  /** The data folder. Defaults to the database's folder. */
  dataDir?: string;
  /** USB, S3 and weekly CSV settings. Without them only the backups on the hub are made. */
  settings?: { backups(): BackupSettings };
  /** For the weekly CSV export. */
  pills?: { list(): Pill[] };
  brews?: { list(): Brew[] };
  /** Where the USB stick is mounted (/mnt/rapthooker), and how to tell whether it is. */
  usbDir?: string;
  usbCheck?: UsbCheck;
  /** Restarts the hub to finish a restore; returns false when it can't (development). */
  restart?: () => boolean;
  now?: () => Date;
}

interface TargetState {
  at: number | null;
  ok: boolean | null;
  error: string | null;
  file: string | null;
  note: string | null;
}

type Offsite = 'usb' | 's3';

const NEVER: TargetState = { at: null, ok: null, error: null, file: null, note: null };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Once a day at the configured local time: raw-data retention, an online database backup to <dataDir>/backups (or
 * backup.dir), copied to a USB stick and S3 when they're switched on, and on Sundays a CSV export of recent brews.
 */
export class Maintenance {
  private timer: NodeJS.Timeout | undefined;
  private daily: Promise<void> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private jobs = 0;
  lastBackup: { at: number; file: string } | null = null;
  backupError: string | null = null;
  /** Where the daily backups are kept. */
  readonly dir: string;
  readonly dataDir: string;
  readonly usbDir: string;
  /** Restarts the hub to finish a restore (replaceable in tests). */
  restart: () => boolean;
  private readonly targets: Record<Offsite, TargetState>;
  private csvState: BackupOverview['csv'];
  private readonly usbCheck: UsbCheck;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly opts: MaintenanceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.dataDir = opts.dataDir ?? dirname(store.path);
    this.dir = opts.backupDir || join(this.dataDir, 'backups');
    this.usbDir = opts.usbDir ?? USB_DIR;
    this.usbCheck = opts.usbCheck ?? usbMounted;
    this.restart = opts.restart ?? (() => restartForRestore(log));
    this.lastBackup = this.meta('lastBackup', null);
    const saved = this.meta<Partial<Record<Offsite, TargetState>>>('backupTargets', {});
    this.targets = { usb: { ...NEVER, ...saved.usb }, s3: { ...NEVER, ...saved.s3 } };
    this.csvState = this.meta('lastCsv', { at: null, folder: null, error: null });
    this.tidyTemp();
  }

  private meta<T>(key: string, fallback: T): T {
    try {
      const raw = this.store.getMeta(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  /** Leftovers from downloads or uploads cut short by a restart. */
  private tidyTemp(): void {
    try {
      for (const f of readdirSync(this.dataDir)) {
        if (/^(download-.+|restore-upload)\.partial(-wal|-shm|-journal)?$/.test(f)) rmSync(join(this.dataDir, f), { force: true });
      }
    } catch {}
  }

  private backupSettings(): BackupSettings | null {
    try {
      return this.opts.settings?.backups() ?? null;
    } catch (err) {
      this.log.warn({ err: message(err) }, "couldn't read the backup settings");
      return null;
    }
  }

  private setTarget(target: Offsite, patch: Partial<TargetState>): void {
    this.targets[target] = { ...this.targets[target], ...patch };
    this.store.setMeta('backupTargets', JSON.stringify(this.targets));
  }

  private setCsv(state: BackupOverview['csv']): void {
    this.csvState = state;
    this.store.setMeta('lastCsv', JSON.stringify(state));
  }

  /** How the last backup to each place went (the USB stick and S3 only when they're switched on). */
  status(): BackupTargetStatus[] {
    const out: BackupTargetStatus[] = [
      {
        target: 'local',
        at: this.lastBackup?.at ?? null,
        ok: this.backupError ? false : this.lastBackup ? true : null,
        error: this.backupError,
        file: this.lastBackup?.file ?? null,
        note: null,
      },
    ];
    const b = this.backupSettings();
    if (b?.usb) out.push({ target: 'usb', ...this.targets.usb });
    if (b?.s3.enabled) out.push({ target: 's3', ...this.targets.s3 });
    return out;
  }

  /** The backups kept on the hub, newest first: the daily ones and the copies made just before a restore or an update. */
  files(): BackupFile[] {
    const list = (dir: string, re: RegExp, kind: BackupFile['kind']): BackupFile[] => {
      try {
        return readdirSync(dir)
          .filter((f) => re.test(f))
          .flatMap((name) => {
            const st = statSync(join(dir, name));
            return st.isFile() ? [{ name, bytes: st.size, at: Math.round(st.mtimeMs), kind }] : [];
          });
      } catch {
        return [];
      }
    };
    return [
      ...list(this.dir, BACKUP_RE, 'daily'),
      ...list(this.dataDir, PRE_RESTORE_RE, 'pre-restore'),
      ...list(this.dataDir, PRE_UPDATE_RE, 'pre-update'),
    ].sort((a, b) => b.at - a.at);
  }

  /** The full path of a file from files(), or null. Only listed names work, so nothing else can be reached. */
  fileByName(name: string): string | null {
    const f = this.files().find((x) => x.name === name);
    return f ? join(f.kind === 'daily' ? this.dir : this.dataDir, f.name) : null;
  }

  async overview(): Promise<BackupOverview> {
    const b = this.backupSettings();
    return {
      dir: this.dir,
      time: this.opts.backupTime,
      keep: this.opts.keep,
      files: this.files(),
      targets: this.status(),
      usbPresent: b?.usb ? await this.usbCheck(this.usbDir).catch(() => false) : null,
      csv: this.csvState,
      lastRestore: this.meta('lastRestore', null),
      running: this.running,
    };
  }

  /** A backup is being made right now. */
  get running(): boolean {
    return this.jobs > 0;
  }

  /** Runs jobs one at a time (the daily run, "back up now"). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.jobs++;
      try {
        return await fn();
      } finally {
        this.jobs--;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => this.log.error({ err: message(err) }, 'daily maintenance failed'));
    }, 60_000);
    this.timer.unref();
  }

  /** Stops the timer and waits (up to 10 s) for a backup that's running, so the database isn't closed under it. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([this.chain, new Promise((resolve) => (timeout = setTimeout(resolve, 10_000)))]);
    clearTimeout(timeout);
  }

  async tick(): Promise<void> {
    if (this.daily) return;
    const now = this.now();
    const today = localDate(now);
    const [hh, mm] = this.opts.backupTime.split(':').map(Number) as [number, number];
    const due = now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm);
    if (!due || this.store.getMeta('lastDailyRun') === today) return;
    this.daily = this.runDaily(today).finally(() => (this.daily = undefined));
    await this.daily;
  }

  runDaily(today = localDate(this.now())): Promise<void> {
    return this.exclusive(async () => {
      if (this.opts.rawRetentionDays > 0) {
        try {
          const pruned = this.store.pruneRaw(this.now().getTime() - this.opts.rawRetentionDays * DAY);
          if (pruned > 0) this.log.info({ pruned }, 'deleted old raw readings');
        } catch (err) {
          this.log.error({ err: message(err) }, "couldn't delete old raw readings");
        }
      }
      await this.backupEverywhere(today);
      if (this.csvDue()) await this.weeklyCsv(today);
      this.store.setMeta('lastDailyRun', today);
    });
  }

  /** "Back up now": a backup on the hub, copied to the USB stick and S3 when they're on. */
  backupNow(): Promise<BackupTargetStatus[]> {
    return this.exclusive(async () => {
      await this.backupEverywhere(localDate(this.now()));
      return this.status();
    });
  }

  private async backupEverywhere(today: string): Promise<void> {
    const file = await this.backup(today);
    if (!file) return;
    await this.toUsb(file);
    await this.toS3(file);
  }

  /** Today's backup on the hub (replacing one made earlier today), keeping the newest `keep`. */
  async backup(today = localDate(this.now())): Promise<string | null> {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `rapthooker-${today}.db`);
      await snapshot(this.store, file);
      await pruneFiles(this.dir, BACKUP_RE, this.opts.keep);
      this.lastBackup = { at: this.now().getTime(), file };
      this.backupError = null;
      this.store.setMeta('lastBackup', JSON.stringify(this.lastBackup));
      this.log.info({ file, bytes: statSync(file).size }, 'backup complete');
      return file;
    } catch (err) {
      this.backupError = `Backup failed: ${message(err)}`;
      this.log.error({ err: message(err) }, 'backup failed');
      return null;
    }
  }

  private async toUsb(file: string): Promise<void> {
    if (!this.backupSettings()?.usb) return;
    try {
      if (!(await this.usbCheck(this.usbDir))) {
        this.setTarget('usb', { ok: null, error: null, note: 'No USB stick plugged in' });
        this.log.info('no USB backup stick plugged in: skipped copying the backup');
        return;
      }
      const dest = await copyInto(file, this.usbDir, basename(file));
      await pruneFiles(this.usbDir, BACKUP_RE, OFFSITE_KEEP);
      this.setTarget('usb', { at: this.now().getTime(), ok: true, error: null, file: dest, note: null });
      this.log.info({ file: dest }, 'copied the backup to the USB stick');
    } catch (err) {
      this.setTarget('usb', { ok: false, error: usbErrorText(err), note: null });
      this.log.warn({ err: message(err) }, 'copying the backup to the USB stick failed');
    }
  }

  private async toS3(file: string): Promise<void> {
    const s3 = this.backupSettings()?.s3;
    if (!s3?.enabled) return;
    try {
      const client = new S3Client(s3);
      const prefix = normalizePrefix(s3.prefix);
      const key = `${prefix}${basename(file)}`;
      await client.putFile(key, file);
      let note: string | null = null;
      try {
        const deleted = await pruneS3Backups(client, prefix, OFFSITE_KEEP);
        if (deleted) this.log.info({ deleted }, 'deleted old backups from S3');
      } catch (err) {
        note = `Uploaded, but old backups couldn't be tidied up: ${message(err)}`;
        this.log.warn({ err: message(err) }, "couldn't delete old backups from S3");
      }
      this.setTarget('s3', { at: this.now().getTime(), ok: true, error: null, file: key, note });
      this.log.info({ key }, 'uploaded the backup to S3');
    } catch (err) {
      this.setTarget('s3', { ok: false, error: message(err), note: null });
      this.log.warn({ err: message(err) }, 'uploading the backup to S3 failed');
    }
  }

  /** Sundays, or any day once a Sunday was missed. */
  private csvDue(): boolean {
    if (!this.backupSettings()?.weeklyCsv || !this.opts.pills || !this.opts.brews) return false;
    const now = this.now();
    if (this.csvState.folder && basename(this.csvState.folder) === localDate(now)) return false;
    return now.getDay() === 0 || (this.csvState.at !== null && now.getTime() - this.csvState.at >= 8 * DAY);
  }

  /** Writes recent brews and each pill's last week as CSV into <backups>/csv/YYYY-MM-DD and copies them off the hub. */
  async weeklyCsv(today = localDate(this.now())): Promise<string | null> {
    if (!this.opts.pills || !this.opts.brews) return null;
    const root = join(this.dir, 'csv');
    const folder = join(root, today);
    let files: string[];
    try {
      files = await writeWeeklyCsv(this.store, this.opts.pills.list(), this.opts.brews.list(), folder, this.now().getTime());
      await pruneFiles(root, WEEK_RE, CSV_KEEP_WEEKS, true);
      this.log.info({ folder, files: files.length }, 'weekly CSV export done');
    } catch (err) {
      this.setCsv({ ...this.csvState, error: `The weekly CSV export failed: ${message(err)}` });
      this.log.error({ err: message(err) }, 'weekly CSV export failed');
      return null;
    }
    const problems: string[] = [];
    const b = this.backupSettings();
    if (b?.usb) {
      try {
        if (await this.usbCheck(this.usbDir)) {
          await copyFolder(folder, join(this.usbDir, 'csv', today));
          await pruneFiles(join(this.usbDir, 'csv'), WEEK_RE, CSV_KEEP_WEEKS, true);
        }
      } catch (err) {
        problems.push(usbErrorText(err));
        this.log.warn({ err: message(err) }, 'copying the CSV export to the USB stick failed');
      }
    }
    if (b?.s3.enabled) {
      try {
        const client = new S3Client(b.s3);
        const prefix = normalizePrefix(b.s3.prefix);
        for (const f of files) await client.putFile(`${prefix}csv/${today}/${f}`, join(folder, f), 'text/csv; charset=utf-8');
        await pruneS3Csv(client, prefix, CSV_KEEP_WEEKS);
      } catch (err) {
        problems.push(`Uploading to S3 failed: ${message(err)}`);
        this.log.warn({ err: message(err) }, 'uploading the CSV export to S3 failed');
      }
    }
    this.setCsv({ at: this.now().getTime(), folder, error: problems.length ? `Saved on the hub. ${problems.join(' ')}` : null });
    return folder;
  }
}
