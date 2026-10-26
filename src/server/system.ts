import { existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { BackupTargetStatus, BleStatus, DiskStatus, HubAddress, HubWarning } from '@rapthooker/shared';
import type { Config } from './config.js';
import { COMPACT_AFTER_UPGRADE_KEY, type Store } from './db.js';
import type { Logger } from './log.js';
import type { Advert } from './ble/scanner.js';
import { KEG_COMPANY_ID, RAPT_COMPANY_ID } from './ble/rapt.js';
import { TIMESYNC_FILE } from './clock.js';
import { SystemdNotifier, execFileAsync, type ExecFn } from './system/notify.js';
import {
  EMERGENCY_FREE_BYTES,
  compactionDue,
  dbFileBytes,
  dbPages,
  emergencyCleanup,
  planCompaction,
  vacuum,
  type CleanupResult,
} from './system/compaction.js';
import { listAddresses, tailscaleDnsName, tailscaleServeUrl, type Interfaces } from './system/addresses.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
/** Free disk below this gets a warning; below EMERGENCY_FREE_BYTES an error (and old logs are trimmed). */
const LOW_DISK_BYTES = 500 * MB;
const LARGE_DB_BYTES = GB;
/** The event loop counts as slow when its 99th percentile delay is over this… */
const SLOW_LOOP_MS = 1000;
/** …and a warning shows once it has been slow for this many checks (30 s each) in a row. */
const SLOW_LOOP_CHECKS = 3;
const LOOP_CHECK_MS = 30_000;
const HOUSEKEEPING_MS = 10 * 60_000;
const DATA_SIZE_CACHE_MS = 5 * 60_000;
const TAILSCALE_CACHE_MS = 5 * 60_000;
const ADVERTS_KEPT = 200;
/** How long the watchdog may wait while the database is compacted (the event loop is blocked meanwhile). */
const COMPACT_WATCHDOG_USEC = 15 * 60 * 1_000_000;
/** After an update upgraded the database, compacting waits this long (the installer is checking the hub answers). */
const COMPACT_AFTER_UPGRADE_MS = 5 * 60_000;

/** An advert as heard, for the diagnostics bundle. Only RAPT and KegLand data is kept; other makers' is just measured. */
export interface AdvertSample {
  at: number;
  address: string;
  rssi: number | null;
  cached: boolean;
  data: { companyId: number; hex: string | null; length: number }[];
}

interface ScannerLike {
  readonly status: BleStatus;
  on(event: 'advert', listener: (advert: Advert) => void): unknown;
  off(event: 'advert', listener: (advert: Advert) => void): unknown;
}

interface ClockLike {
  readonly trusted: boolean;
  on(event: 'trusted', listener: (info: { synced: boolean }) => void): unknown;
}

interface MaintenanceLike {
  /** A backup is being made right now. */
  readonly running: boolean;
  status(): BackupTargetStatus[];
}

interface StatFs {
  bsize: number;
  blocks: number;
  bavail: number;
}

export interface SystemDeps {
  scanner?: ScannerLike;
  clock?: ClockLike;
  maintenance?: MaintenanceLike;
  /** Stops the hub through the normal shutdown; systemd (Restart=always) or Docker starts it again. */
  restart?: () => void;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  interfaces?: () => Interfaces;
  hostname?: () => string;
  statfs?: (path: string) => StatFs;
  exists?: (path: string) => boolean;
  now?: () => number;
}

export interface LoopStats {
  /** 99th percentile event-loop delay over the last check, ms. */
  p99Ms: number;
  maxMs: number;
  slow: boolean;
}

export interface CompactionOutcome {
  ran: boolean;
  reason: string;
  /** Worth trying again soon (something was busy, or it failed), rather than next week. */
  retry: boolean;
  reclaimedBytes?: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function formatBytes(n: number): string {
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  if (n < GB) return `${Math.round(n / MB)} MB`;
  return `${(n / GB).toFixed(1)} GB`;
}

/** Adds up the files under a folder (not following links). Quietly skips anything it can't read. */
function folderBytes(dir: string, depth = 0): number {
  if (depth > 6) return 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    const path = join(dir, e.name);
    try {
      if (e.isDirectory()) total += folderBytes(path, depth + 1);
      else if (e.isFile()) total += lstatSync(path).size;
    } catch {
      // Gone or unreadable.
    }
  }
  return total;
}

/**
 * The hub as a machine: the systemd watchdog, event-loop health, disk space, database compaction, warnings, its
 * addresses, recent adverts for the diagnostics bundle, and restarting.
 */
export class SystemService {
  private readonly notifier: SystemdNotifier;
  private readonly inDocker: boolean;
  private readonly now: () => number;
  private readonly exec: ExecFn;
  private readonly adverts: AdvertSample[] = [];
  private histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private loopTimer: NodeJS.Timeout | undefined;
  private watchdogTimer: NodeJS.Timeout | undefined;
  private housekeepingTimer: NodeJS.Timeout | undefined;
  private firstHousekeeping: NodeJS.Timeout | undefined;
  private pinging = false;
  private readonly loop = { p99Ms: 0, maxMs: 0, slowChecks: 0, ignoreUntil: 0 };
  private dataSize = { at: 0, bytes: 0 };
  private tailscale: { at: number; url: string | null } | null = null;
  private tailscaleLookup: Promise<string | null> | null = null;
  private clockGaveUp = false;
  private compacting = false;
  private lastEmergencyAt = 0;
  private restarting = false;
  private started = false;
  private startedAt = 0;
  private isReady = false;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly deps: SystemDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.exec = deps.exec ?? execFileAsync;
    this.notifier = new SystemdNotifier(log, this.exec, deps.env ?? process.env);
    this.inDocker = (deps.exists ?? existsSync)('/.dockerenv');
    deps.clock?.on('trusted', ({ synced }) => {
      this.clockGaveUp = !synced;
    });
  }

  /** Started by systemd or Docker, which start the hub again if it exits (systemd also if it stops answering the watchdog). */
  get supervised(): boolean {
    return this.notifier.enabled || this.inDocker;
  }

  get canRestart(): boolean {
    return Boolean(this.deps.restart);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = this.now();
    this.deps.scanner?.on('advert', this.onAdvert);
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
      this.loopTimer = setInterval(() => this.guard('checking the event loop', () => this.sampleLoop()), LOOP_CHECK_MS);
      this.loopTimer.unref();
    } catch (err) {
      this.log.warn({ err: errorText(err) }, "can't watch the event loop");
    }
    this.firstHousekeeping = setTimeout(() => void this.housekeeping(), 60_000);
    this.firstHousekeeping.unref();
    this.housekeepingTimer = setInterval(() => void this.housekeeping(), HOUSEKEEPING_MS);
    this.housekeepingTimer.unref();
  }

  stop(): void {
    this.started = false;
    this.deps.scanner?.off('advert', this.onAdvert);
    clearInterval(this.loopTimer);
    clearInterval(this.watchdogTimer);
    clearInterval(this.housekeepingTimer);
    clearTimeout(this.firstHousekeeping);
    this.histogram?.disable();
    if (this.isReady) void this.notifier.notify('STOPPING=1', 'STATUS=Stopping');
    this.isReady = false;
  }

  /**
   * Tells systemd the hub has started (Type=notify) and starts the watchdog pings. They're sent from a timer on the
   * main event loop, so if the loop ever hangs the pings stop and systemd restarts the hub (WatchdogSec).
   */
  ready(): void {
    if (!this.notifier.enabled) return;
    this.isReady = true;
    void this.notifier.notify('READY=1', `STATUS=Recording; web app on port ${this.config.port}`);
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => this.pingWatchdog(), this.notifier.pingEveryMs);
    this.watchdogTimer.unref();
  }

  /** One watchdog ping (skipped while the last one is still on its way). */
  pingWatchdog(): void {
    if (this.pinging || !this.notifier.enabled) return;
    this.pinging = true;
    void this.notifier.notify('WATCHDOG=1').finally(() => (this.pinging = false));
  }

  // ---------- Event loop ----------

  private sampleLoop(): void {
    const h = this.histogram;
    if (!h) return;
    const ms = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : 0);
    const p99 = ms(h.percentile(99));
    const max = ms(h.max);
    h.reset();
    this.checkLoop(p99, max);
  }

  /** Records one check's delays, and logs when they're bad. */
  checkLoop(p99Ms: number, maxMs: number): void {
    this.loop.p99Ms = p99Ms;
    this.loop.maxMs = maxMs;
    // Compacting blocks the loop on purpose.
    if (this.compacting || this.now() < this.loop.ignoreUntil) return;
    if (p99Ms > SLOW_LOOP_MS) {
      this.loop.slowChecks++;
      this.log.warn({ p99Ms: Math.round(p99Ms), maxMs: Math.round(maxMs) }, 'the hub is responding slowly (event loop delayed)');
    } else {
      this.loop.slowChecks = 0;
      if (maxMs > 5000) this.log.warn({ maxMs: Math.round(maxMs) }, 'the event loop was blocked for a while');
    }
  }

  loopStats(): LoopStats {
    return { p99Ms: Math.round(this.loop.p99Ms), maxMs: Math.round(this.loop.maxMs), slow: this.loop.slowChecks >= SLOW_LOOP_CHECKS };
  }

  // ---------- Disk ----------

  disk(): DiskStatus | null {
    try {
      const fs = (this.deps.statfs ?? statfsSync)(this.config.dataDir);
      const now = this.now();
      if (now - this.dataSize.at > DATA_SIZE_CACHE_MS) this.dataSize = { at: now, bytes: folderBytes(this.config.dataDir) };
      return {
        totalBytes: fs.blocks * fs.bsize,
        freeBytes: fs.bavail * fs.bsize,
        dataBytes: this.dataSize.bytes,
        dbBytes: dbFileBytes(this.store.path),
      };
    } catch {
      return null;
    }
  }

  // ---------- Warnings ----------

  /** Things the owner should know about, with what to do. Ids are stable so the app can remember dismissed ones. */
  warnings(): HubWarning[] {
    const out: HubWarning[] = [];
    const disk = this.disk();
    if (disk && disk.freeBytes < EMERGENCY_FREE_BYTES) {
      out.push({
        id: 'disk-critical',
        level: 'error',
        message:
          `Storage is almost full (${formatBytes(disk.freeBytes)} free), so new readings may soon fail to save. Old webhook logs ` +
          'and alert history have been trimmed to make room. Free up space on the SD card, or move to a bigger one.',
      });
    } else if (disk && disk.freeBytes < LOW_DISK_BYTES) {
      out.push({
        id: 'disk-low',
        level: 'warn',
        message: `Storage is getting low (${formatBytes(disk.freeBytes)} free). Delete old backups or other files you don't need, or use a bigger SD card.`,
      });
    }
    if (disk && disk.dbBytes > LARGE_DB_BYTES) {
      const retention = this.config.rawRetentionDays;
      out.push({
        id: 'db-large',
        level: 'info',
        message:
          `The database is ${formatBytes(disk.dbBytes)}. ` +
          (retention > 0
            ? `A shorter rawRetentionDays in the config file (now ${retention} days) keeps it smaller: older readings are kept as 15-minute averages.`
            : 'Setting rawRetentionDays in the config file keeps it smaller: readings older than that are kept as 15-minute averages.'),
      });
    }
    const clock = this.deps.clock;
    if (clock && !clock.trusted) {
      out.push({
        id: 'clock-waiting',
        level: 'warn',
        message:
          "Waiting for the clock to be set from the network: new readings are held until it is. Check the hub's internet connection.",
      });
    } else if (this.clockGaveUp) {
      if ((this.deps.exists ?? existsSync)(TIMESYNC_FILE)) this.clockGaveUp = false;
      else {
        out.push({
          id: 'clock-not-synced',
          level: 'warn',
          message:
            "The clock hasn't been set from the network, so reading times may be off. Check the hub's internet connection " +
            '(`timedatectl` on the Pi shows whether the clock is synced).',
        });
      }
    }
    const ble = this.deps.scanner?.status;
    if (ble?.state === 'error') {
      out.push({
        id: 'ble-error',
        level: 'error',
        message:
          `Bluetooth isn't working${ble.error ? ` (${ble.error})` : ''}. RaptHooker keeps trying; if it doesn't recover, ` +
          'restart Bluetooth (`sudo systemctl restart bluetooth`) or the Pi.',
      });
    } else if (ble?.state === 'unavailable') {
      out.push({
        id: 'ble-unavailable',
        level: 'warn',
        message: `No Bluetooth${ble.error ? ` (${ble.error})` : ''}. Pills can't be heard until it's available.`,
      });
    }
    for (const b of this.deps.maintenance?.status() ?? []) {
      // "Backups are off" isn't a failure.
      if (b.ok !== false || !b.error || /^Backups are off\b/i.test(b.error)) continue;
      const where = b.target === 'usb' ? 'USB stick' : b.target === 's3' ? 'cloud (S3)' : 'nightly';
      out.push({
        id: `backup-failed-${b.target}`,
        level: 'warn',
        message: `The last ${where} backup failed: ${b.error.replace(/^Backup failed:\s*/i, '')}. Check the backup settings.`,
      });
    }
    if (this.loopStats().slow) {
      out.push({
        id: 'event-loop-slow',
        level: 'warn',
        message:
          `The hub has been responding slowly for a while (delays of ${(this.loop.p99Ms / 1000).toFixed(1)} s). ` +
          'Restarting it usually helps; if it keeps happening, download the diagnostics and open an issue on GitHub.',
      });
    }
    return out;
  }

  // ---------- Housekeeping: emergency cleanup, and compaction after an upgrade and weekly ----------

  private async housekeeping(): Promise<void> {
    try {
      this.checkDiskSpace();
      // An upgrade that rebuilt a table leaves its old space unused (and copied into every backup) until compacted.
      if (this.store.getMeta(COMPACT_AFTER_UPGRADE_KEY) !== null && this.now() - this.startedAt >= COMPACT_AFTER_UPGRADE_MS) {
        const outcome = await this.compact();
        if (!outcome.retry) this.store.deleteMeta(COMPACT_AFTER_UPGRADE_KEY);
        return;
      }
      const last = Number(this.store.getMeta('lastCompactionCheck') ?? 0);
      if (!compactionDue(new Date(this.now()), this.config.backup.time, last)) return;
      const outcome = await this.compact();
      if (!outcome.retry) this.store.setMeta('lastCompactionCheck', String(this.now()));
    } catch (err) {
      this.log.error({ err: errorText(err) }, 'housekeeping failed');
    }
  }

  /** When the disk is nearly full: trims old logs (never readings) and shrinks the write-ahead log. At most hourly. */
  checkDiskSpace(): CleanupResult | null {
    const disk = this.disk();
    if (!disk || disk.freeBytes >= EMERGENCY_FREE_BYTES || this.now() - this.lastEmergencyAt < 3_600_000) return null;
    this.lastEmergencyAt = this.now();
    try {
      const result = emergencyCleanup(this.store, this.now());
      this.log.warn({ freeBytes: disk.freeBytes, ...result }, 'storage almost full: trimmed old webhook logs and alert history');
      return result;
    } catch (err) {
      this.log.error({ err: errorText(err), freeBytes: disk.freeBytes }, 'storage almost full, and trimming old logs failed');
      return null;
    }
  }

  /**
   * Compacts the database (VACUUM) when over a fifth of it is unused space and there's room on the disk. Never while
   * the nightly backup runs. The event loop is blocked meanwhile, so the watchdog is given longer.
   */
  async compact(): Promise<CompactionOutcome> {
    if (this.compacting) return { ran: false, reason: 'already compacting', retry: true };
    if (this.deps.maintenance?.running) return { ran: false, reason: 'a backup is running', retry: true };
    let plan;
    try {
      plan = planCompaction(dbPages(this.store.db), dbFileBytes(this.store.path), this.disk()?.freeBytes ?? null);
    } catch (err) {
      this.log.error({ err: errorText(err) }, "couldn't check whether the database needs compacting");
      return { ran: false, reason: errorText(err), retry: false };
    }
    if (!plan.run) {
      this.log.info({ reason: plan.reason }, 'database compaction not needed');
      return { ran: false, reason: plan.reason, retry: false };
    }
    this.compacting = true;
    const watchdog = this.notifier.watchdogMs;
    try {
      if (watchdog && !(await this.notifier.notify('WATCHDOG=1', `WATCHDOG_USEC=${COMPACT_WATCHDOG_USEC}`))) {
        this.log.warn("couldn't give the watchdog longer: not compacting the database this time");
        return { ran: false, reason: "couldn't extend the watchdog", retry: true };
      }
      // Marked as done before it starts: if it's cut short (the watchdog, a power cut), it isn't tried again every night.
      this.store.setMeta('lastCompactionCheck', String(this.now()));
      this.log.info({ reason: plan.reason }, 'compacting the database');
      const r = vacuum(this.store);
      const reclaimedBytes = Math.max(0, r.beforeBytes - r.afterBytes);
      this.log.info({ beforeBytes: r.beforeBytes, afterBytes: r.afterBytes, reclaimedBytes, ms: r.ms }, 'compacted the database');
      return { ran: true, reason: plan.reason, retry: false, reclaimedBytes };
    } catch (err) {
      this.log.error({ err: errorText(err) }, 'compacting the database failed');
      return { ran: false, reason: errorText(err), retry: true };
    } finally {
      this.compacting = false;
      this.loop.ignoreUntil = this.now() + LOOP_CHECK_MS + 5000;
      if (watchdog) void this.notifier.notify(`WATCHDOG_USEC=${Math.round(watchdog * 1000)}`, 'WATCHDOG=1');
    }
  }

  // ---------- Addresses ----------

  /** Addresses the hub can be reached on: LAN IPs, its .local name and (unless turned off) its Tailscale name. */
  async addresses(opts: { tailscale?: boolean } = {}): Promise<HubAddress[]> {
    let interfaces: Interfaces = {};
    try {
      interfaces = (this.deps.interfaces ?? networkInterfaces)();
    } catch (err) {
      this.log.warn({ err: errorText(err) }, "couldn't list the network interfaces");
    }
    return listAddresses({
      interfaces,
      hostname: (this.deps.hostname ?? osHostname)(),
      port: this.config.port,
      tailscaleUrl: opts.tailscale === false ? null : await this.tailscaleUrl(),
    });
  }

  /** The https URL from `tailscale serve`, cached for 5 minutes. Null when Tailscale isn't installed, up or usable. */
  private async tailscaleUrl(): Promise<string | null> {
    if (this.tailscale && this.now() - this.tailscale.at < TAILSCALE_CACHE_MS) return this.tailscale.url;
    this.tailscaleLookup ??= this.lookUpTailscale().finally(() => (this.tailscaleLookup = null));
    const url = await this.tailscaleLookup;
    this.tailscale = { at: this.now(), url };
    return url;
  }

  private async lookUpTailscale(): Promise<string | null> {
    const run = async (args: string[]) => {
      try {
        return (await this.exec('tailscale', args, { timeout: 3000 })).stdout;
      } catch {
        return null;
      }
    };
    const status = await run(['status', '--json']);
    const dns = status ? tailscaleDnsName(status) : null;
    if (!dns) return null;
    const served = tailscaleServeUrl(await run(['serve', 'status', '--json']), dns);
    return served === undefined ? `https://${dns}` : served;
  }

  // ---------- Adverts, for the diagnostics bundle ----------

  private readonly onAdvert = (a: Advert): void => {
    // Only heard again, nothing new (BlueZ's monitor does that for every advert): it would crowd out the rest.
    if (a.manufacturer === null && a.rssi === null) return;
    try {
      const data = [...(a.manufacturer ?? new Map<number, Uint8Array>())].map(([companyId, bytes]) => ({
        companyId,
        hex: companyId === RAPT_COMPANY_ID || companyId === KEG_COMPANY_ID ? Buffer.from(bytes).toString('hex') : null,
        length: bytes.length,
      }));
      this.adverts.push({ at: a.at, address: a.address, rssi: a.rssi, cached: a.cached, data });
      if (this.adverts.length > ADVERTS_KEPT) this.adverts.splice(0, this.adverts.length - ADVERTS_KEPT);
    } catch {
      // Only for diagnostics: never let it get in the way of recording.
    }
  };

  /** The last 200 adverts heard, oldest first. */
  recentAdverts(): AdvertSample[] {
    return this.adverts.map((a) => ({ ...a, data: a.data.map((d) => ({ ...d })) }));
  }

  // ---------- Restart ----------

  /** Exits through the normal shutdown in half a second (once the reply has gone); systemd starts the hub again. */
  restart(): boolean {
    const restart = this.deps.restart;
    if (!restart) return false;
    if (this.restarting) return true;
    this.restarting = true;
    this.log.warn(this.supervised ? 'restart requested: back in a few seconds' : 'restart requested: start it again');
    setTimeout(() => {
      try {
        restart();
      } catch (err) {
        this.restarting = false;
        this.log.error({ err: errorText(err) }, 'restart failed');
      }
    }, 500);
    return true;
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.error({ err: errorText(err) }, `${what} failed`);
    }
  }
}
