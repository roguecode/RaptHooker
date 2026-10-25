import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DevBuild, HubSettings, UpdateInfo } from '@rapthooker/shared';
import type { Store } from './db.js';
import type { Logger } from './log.js';
import type { Settings } from './settings.js';

export const REPO = 'roguecode/RaptHooker';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** The app asks for an update by creating this file in the data folder; rapthooker-update.path notices it. */
export const REQUEST_FILE = 'update-request';
/** Written by deploy/pi/update.sh when it has finished. */
export const STATUS_FILE = 'update-status.json';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FETCH_TIMEOUT_MS = 10_000;
/** The updater should pick up a request within seconds; this long means it isn't there. */
const PICKUP_TIMEOUT_MS = 2 * MINUTE;
/** Downloading, installing packages and restarting on a slow Pi with a slow connection. */
const UPDATE_TIMEOUT_MS = 20 * MINUTE;
const MAX_NOTES = 20_000;

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

export interface UpdateOptions {
  /** The service's data folder, where the update request and the updater's status file go. */
  dataDir?: string;
  /** Keeps the last check across restarts. */
  store?: Store;
  fetch?: typeof fetch;
  now?: () => number;
  /** Written by install.sh. Default /opt/rapthooker/.installer (or RAPTHOOKER_INSTALL_MARKER). */
  installMarker?: string;
  /** Written by deploy.ps1 / deploy.sh: the hub runs a development build. Default .dev-build next to the installer's marker. */
  devMarker?: string;
  /** What update.sh runs to install a release. Default deploy/install.sh next to the installer's marker. */
  installer?: string;
  /** The git commit and time this was built from, shown on development builds. */
  build?: DevBuild;
  /** Running straight from the source (the dev server): a development build that can't replace itself. */
  fromSource?: boolean;
  /** Installed by setup.d/40-updates.sh. Default /etc/systemd/system/rapthooker-update.path (or RAPTHOOKER_UPDATE_UNIT). */
  pathUnit?: string;
  /** The first automatic check after starting. */
  firstCheckDelayMs?: number;
  /** How often to look for the updater's result while updating. */
  pollMs?: number;
}

interface SavedCheck {
  latest: string | null;
  notes: string | null;
  url: string | null;
  checkedAt: number;
  error: string | null;
  /** When the next automatic check is due. */
  nextAt: number;
}

interface Pending {
  version: string;
  requestedAt: number;
}

/** What update.sh writes. */
export interface UpdaterStatus {
  ok: boolean;
  version?: string | null;
  from?: string | null;
  at?: number;
  error?: string | null;
}

interface Release {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface Version {
  core: [number, number, number];
  pre: (string | number)[];
}

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/** Semantic version order: negative if a is older than b, 0 if equal, positive if newer; null if either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  // A pre-release (1.0.0-beta) comes before the release itself.
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return (compareVersions(candidate, current) ?? 0) > 0;
}

/**
 * Checks GitHub for new releases (once a day, if enabled) and starts a self-update on hubs installed with install.sh.
 * A development build (deployed from source) isn't offered updates, but can be switched back to the latest release.
 * Emits 'update' (UpdateInfo).
 *
 * The service can't write outside its data folder, so updating is done by root: the app writes <dataDir>/update-request,
 * which starts rapthooker-update.service (deploy/pi/update.sh) through rapthooker-update.path. update.sh installs the
 * release, restarts the hub (going back to the previous version if the new one doesn't start) and writes
 * <dataDir>/update-status.json, which is read here.
 */
export class UpdateService extends EventEmitter {
  private readonly dataDir: string | null;
  private readonly store: Store | null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly marker: string;
  private readonly devMarker: string;
  private readonly installer: string;
  private readonly pathUnit: string;
  private readonly build: DevBuild | null;
  private readonly fromSource: boolean;
  private readonly firstDelay: number;
  private readonly pollMs: number;

  private saved: SavedCheck | null = null;
  private pending: Pending | null = null;
  private state: UpdateInfo['state'] = 'idle';
  private failure: string | null = null;
  private checking: Promise<UpdateInfo> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private watcher: NodeJS.Timeout | undefined;
  private started = false;
  private readonly onHub = (hub: HubSettings) => {
    if (hub.updateCheck && this.started) this.schedule(this.firstDelay);
  };

  constructor(
    private readonly version: string,
    private readonly settings: Settings,
    private readonly log: Logger,
    opts: UpdateOptions = {},
  ) {
    super();
    this.dataDir = opts.dataDir ?? null;
    this.store = opts.store ?? null;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.now = opts.now ?? Date.now;
    this.marker = opts.installMarker ?? process.env.RAPTHOOKER_INSTALL_MARKER ?? '/opt/rapthooker/.installer';
    this.devMarker = opts.devMarker ?? join(dirname(this.marker), '.dev-build');
    this.installer = opts.installer ?? join(dirname(this.marker), 'deploy', 'install.sh');
    this.pathUnit = opts.pathUnit ?? process.env.RAPTHOOKER_UPDATE_UNIT ?? '/etc/systemd/system/rapthooker-update.path';
    this.build = opts.build ?? null;
    this.fromSource = opts.fromSource ?? false;
    this.firstDelay = opts.firstCheckDelayMs ?? MINUTE;
    this.pollMs = opts.pollMs ?? 3000;
    try {
      this.load();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "couldn't read the last update check");
    }
  }

  info(): UpdateInfo {
    const s = this.saved;
    const latest = s?.latest ?? null;
    const dev = this.devBuild();
    return {
      current: this.version,
      latest,
      // A development build's version number doesn't say what it runs, so releases aren't compared with it.
      available: !dev && latest !== null && isNewer(latest, this.version),
      notes: s?.notes ?? null,
      url: s?.url ?? null,
      checkedAt: s?.checkedAt ?? null,
      error: this.state === 'failed' ? this.failure : (s?.error ?? null),
      canSelfUpdate: !dev && this.canSelfUpdate(),
      devBuild: dev,
      canSwitchToRelease: dev !== null && !this.fromSource && this.updaterReady(),
      state: this.state,
    };
  }

  start(): void {
    this.started = true;
    this.settings.on('hub', this.onHub);
    const due = this.saved ? this.saved.nextAt - this.now() : 0;
    this.schedule(Math.max(this.firstDelay, Math.min(HOUR, due)));
    if (this.state === 'updating') this.watch();
  }

  stop(): void {
    this.started = false;
    this.settings.off('hub', this.onHub);
    clearTimeout(this.timer);
    clearInterval(this.watcher);
    this.timer = undefined;
    this.watcher = undefined;
  }

  /** Asks GitHub for the latest release now. Never throws: problems end up in `error`. */
  async check(): Promise<UpdateInfo> {
    this.checking ??= this.runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** "Check now" from the app: a repeat within half a minute gets the answer just fetched. */
  async checkNow(): Promise<UpdateInfo> {
    const s = this.saved;
    if (s && !s.error && this.now() - s.checkedAt < 30_000) return this.info();
    return this.check();
  }

  /** Asks the system to install the latest release (the hub restarts). */
  async apply(): Promise<UpdateInfo> {
    if (this.state === 'updating') return this.info();
    if (this.devBuild()) {
      throw new UpdateError('This hub runs a development build. Switch it to releases to update it from here.');
    }
    if (!this.dataDir || !this.canSelfUpdate()) {
      throw new UpdateError("This hub wasn't set up with the installer, so it can't update itself. See the update instructions.");
    }
    let info = this.info();
    if (!info.available) info = await this.check();
    if (!info.available || !info.latest) {
      throw new UpdateError(info.error ? `Couldn't check for a new version: ${info.error}` : "You're already on the latest version.");
    }
    return this.request(this.dataDir, info.latest);
  }

  /** Replaces a development build with the latest release, whatever their version numbers (the hub restarts). */
  async switchToRelease(): Promise<UpdateInfo> {
    if (this.state === 'updating') return this.info();
    if (!this.devBuild()) throw new UpdateError('This hub is already on a release.');
    if (this.fromSource || !this.dataDir || !this.updaterReady()) {
      throw new UpdateError("This hub can't install a release by itself. Run the installer on it instead (see the update instructions).");
    }
    const info = await this.checkNow();
    if (!info.latest) {
      throw new UpdateError(info.error ? `Couldn't check for releases: ${info.error}` : 'No release has been published yet.');
    }
    return this.request(this.dataDir, info.latest);
  }

  private request(dataDir: string, version: string): UpdateInfo {
    const request: Pending = { version, requestedAt: this.now() };
    const file = join(dataDir, REQUEST_FILE);
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(request));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      throw new UpdateError(`Couldn't ask for the update: ${(err as Error).message}`, 500);
    }
    this.pending = request;
    this.setMeta('update-pending', JSON.stringify(request));
    this.state = 'updating';
    this.failure = null;
    this.log.info({ from: this.version, to: request.version, devBuild: this.devBuild() !== null }, 'update requested');
    this.watch();
    this.publish();
    return this.info();
  }

  /** Deployed from source (marked by deploy.ps1 / deploy.sh) or running from it, rather than installed from a release. */
  private devBuild(): DevBuild | null {
    if (!this.fromSource && !existsSync(this.devMarker)) return null;
    return { commit: this.build?.commit ?? null, changes: this.build?.changes ?? false, builtAt: this.build?.builtAt ?? null };
  }

  private canSelfUpdate(): boolean {
    return existsSync(this.marker) && this.updaterReady();
  }

  /** The root updater is installed, watches this hub's data folder, and has the installer it runs. */
  private updaterReady(): boolean {
    if (!this.dataDir || !existsSync(this.pathUnit) || !existsSync(this.installer)) return false;
    try {
      return readFileSync(this.pathUnit, 'utf8').includes(join(this.dataDir, REQUEST_FILE));
    } catch {
      return false;
    }
  }

  private load(): void {
    const saved = this.getMeta<SavedCheck>('update-check');
    if (saved && typeof saved.checkedAt === 'number') this.saved = saved;
    const pending = this.getMeta<Pending>('update-pending');
    if (pending && typeof pending.requestedAt === 'number') this.pending = pending;
    if (!this.pending && this.dataDir) {
      // A request without a record of it (the database was replaced, say): go along with it.
      const request = readJson<Partial<Pending>>(join(this.dataDir, REQUEST_FILE));
      if (request) this.pending = { version: String(request.version ?? ''), requestedAt: Number(request.requestedAt) || this.now() };
    }

    const status = this.readStatus();
    if (this.pending) {
      if (status && (status.at ?? 0) >= this.pending.requestedAt) this.finish(status, false);
      else this.state = 'updating';
      return;
    }
    // update.sh run by hand, or a result from before this version kept track of requests.
    const seen = Number(this.store?.getMeta('update-status-seen') ?? 0);
    if (status && (status.at ?? 0) > seen) this.finish(status, false);
  }

  private async runCheck(): Promise<UpdateInfo> {
    const now = this.now();
    const previous = this.saved;
    let next: SavedCheck;
    try {
      const res = await this.fetchFn(LATEST_RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `RaptHooker/${this.version} (+https://github.com/${REPO})`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404) {
        next = { latest: null, notes: null, url: null, checkedAt: now, error: null, nextAt: now + DAY };
      } else if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        const at = Math.max(now + HOUR, Number.isFinite(reset) ? reset + MINUTE : 0, Number.isFinite(retryAfter) ? now + retryAfter : 0);
        next = this.failed(
          previous,
          now,
          'GitHub is limiting how often it can be asked. The hub will try again later.',
          Math.min(at, now + DAY),
        );
      } else if (!res.ok) {
        next = this.failed(previous, now, `GitHub answered ${res.status}. The hub will try again later.`, now + 6 * HOUR);
      } else {
        const release = (await res.json()) as Release;
        const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
        const version = parseVersion(tag);
        // /releases/latest skips drafts and pre-releases already; this is in case that ever changes.
        const stable = version && !version.pre.length && !release.draft && !release.prerelease;
        next = stable
          ? {
              latest: tag.replace(/^v/, ''),
              notes: release.body ? release.body.slice(0, MAX_NOTES) : null,
              url: typeof release.html_url === 'string' ? release.html_url : `${RELEASES_URL}/tag/${tag}`,
              checkedAt: now,
              error: null,
              nextAt: now + DAY,
            }
          : { latest: null, notes: null, url: null, checkedAt: now, error: null, nextAt: now + DAY };
      }
    } catch (err) {
      const name = (err as Error).name;
      const message =
        name === 'TimeoutError' || name === 'AbortError'
          ? "GitHub didn't answer in time. The hub will try again later."
          : "Couldn't reach GitHub. Is the hub online? It will try again later.";
      this.log.debug({ err: (err as Error).message }, 'update check failed');
      next = this.failed(previous, now, message, now + HOUR);
    }
    this.saved = next;
    this.setMeta('update-check', JSON.stringify(next));
    const info = this.info();
    if (info.available && previous?.latest !== next.latest)
      this.log.info({ current: this.version, latest: next.latest }, 'a new version is out');
    this.publish();
    return info;
  }

  /** Keeps what was known (an update stays on offer while offline) along with the problem. */
  private failed(previous: SavedCheck | null, now: number, error: string, nextAt: number): SavedCheck {
    return {
      latest: previous?.latest ?? null,
      notes: previous?.notes ?? null,
      url: previous?.url ?? null,
      checkedAt: now,
      error,
      nextAt,
    };
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, delayMs));
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const now = this.now();
      const s = this.saved;
      // A clock that jumped back would otherwise put the next check far away.
      const due = !s || now >= s.nextAt || s.nextAt - now > 2 * DAY;
      if (due && this.settings.hub().updateCheck && this.state !== 'updating') await this.check();
    } catch (err) {
      this.log.error({ err: (err as Error).stack ?? String(err) }, 'update check failed');
    }
    if (!this.started) return;
    const wait = this.saved ? this.saved.nextAt - this.now() : HOUR;
    // Look again at least hourly, so sleeping or a changed clock can't push the check out for long.
    this.schedule(Math.min(HOUR, Math.max(MINUTE, wait)));
  }

  private watch(): void {
    clearInterval(this.watcher);
    this.watcher = setInterval(() => this.poll(), this.pollMs);
    this.watcher.unref();
  }

  private poll(): void {
    try {
      const pending = this.pending;
      if (!pending) {
        clearInterval(this.watcher);
        return;
      }
      const status = this.readStatus();
      if (status && (status.at ?? 0) >= pending.requestedAt) {
        this.finish(status, true);
        return;
      }
      const age = this.now() - pending.requestedAt;
      const request = this.dataDir ? join(this.dataDir, REQUEST_FILE) : null;
      if (request && existsSync(request) && age > PICKUP_TIMEOUT_MS) {
        rmSync(request, { force: true });
        this.finish(
          {
            ok: false,
            error: 'Nothing picked up the update request. Re-run the installer to repair self-updates (see the update instructions).',
          },
          true,
        );
      } else if (age > UPDATE_TIMEOUT_MS) {
        this.finish({ ok: false, error: "The update didn't finish. On the Pi, `journalctl -u rapthooker-update` shows why." }, true);
      }
    } catch (err) {
      this.log.error({ err: (err as Error).stack ?? String(err) }, 'checking on the update failed');
    }
  }

  private finish(status: UpdaterStatus, publish: boolean): void {
    clearInterval(this.watcher);
    this.watcher = undefined;
    if (status.at) this.setMeta('update-status-seen', String(status.at));
    this.pending = null;
    this.store?.deleteMeta('update-pending');
    // update.sh removes the request when it takes it; one still here was never taken, and mustn't start an update later.
    if (this.dataDir) {
      try {
        rmSync(join(this.dataDir, REQUEST_FILE), { force: true });
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, "couldn't remove the update request");
      }
    }
    if (status.ok) {
      this.state = 'idle';
      this.failure = null;
      this.log.info({ from: status.from ?? null, to: status.version ?? this.version }, 'updated');
    } else {
      this.state = 'failed';
      this.failure = status.error?.trim() || "The update didn't work. The hub is still on the version it had.";
      this.log.warn({ error: this.failure, version: status.version ?? null }, 'update failed');
    }
    if (publish) this.publish();
  }

  private readStatus(): UpdaterStatus | null {
    if (!this.dataDir) return null;
    const status = readJson<UpdaterStatus>(join(this.dataDir, STATUS_FILE));
    return status && typeof status.ok === 'boolean' ? status : null;
  }

  private publish(): void {
    this.emit('update', this.info());
  }

  private getMeta<T>(key: string): T | null {
    const raw = this.store?.getMeta(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private setMeta(key: string, value: string): void {
    try {
      this.store?.setMeta(key, value);
    } catch (err) {
      this.log.warn({ err: (err as Error).message, key }, "couldn't save the update state");
    }
  }
}

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
