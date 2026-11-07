import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BetaRelease, DevBuild, HubSettings, UpdateInfo } from '@rapthooker/shared';
import type { Store } from './db.js';
import type { Logger } from './log.js';
import type { Settings } from './settings.js';

export const REPO = 'roguecode/RaptHooker';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Every release, newest first: where the betas (pre-releases) are, as /releases/latest skips them. */
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
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
const MAX_BETAS = 10;
/** Each beta's notes are sent with every update to the app, so long ones are cut (GitHub has them whole). */
const MAX_BETA_NOTES = 8_000;
/** A version update.sh installs: x.y.z, or a beta like x.y.z-beta.1. */
const INSTALLABLE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RATE_LIMITED = 'GitHub is limiting how often it can be asked. The hub will try again later.';

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

/** The beta versions last fetched (kept apart from SavedCheck, which versions from before betas read and write). */
interface SavedBetas {
  betas: BetaRelease[];
  checkedAt: number;
  error: string | null;
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

export interface Release {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  assets?: { name?: string }[];
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

/** A beta: a version with a pre-release part (0.9.0-beta.1). */
export function isBetaVersion(version: string): boolean {
  return (parseVersion(version)?.pre.length ?? 0) > 0;
}

/** Betas of the same line: the same x.y.z and the same name before the number (0.9.0-beta.1 and 0.9.0-beta.2). */
function sameLine(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return Boolean(x && y && x.core.join('.') === y.core.join('.') && x.pre[0] === y.pre[0]);
}

/**
 * The betas in GitHub's list of releases that a hub can install: published (not drafts), with the archive the installer
 * downloads, and not older than the newest release (which has what they were trying out). Newest first.
 */
export function betasFrom(releases: Release[], latest: string | null): BetaRelease[] {
  let newest = latest;
  for (const r of releases) {
    const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
    const v = parseVersion(tag);
    if (v && !v.pre.length && !r.draft && !r.prerelease && (!newest || isNewer(tag, newest))) newest = tag.replace(/^v/, '');
  }
  const seen = new Set<string>();
  const betas: BetaRelease[] = [];
  for (const r of releases) {
    if (r.draft || typeof r.tag_name !== 'string') continue;
    const version = r.tag_name.replace(/^v/, '');
    if (!INSTALLABLE.test(version) || !isBetaVersion(version) || seen.has(version)) continue;
    if (newest && !isNewer(version, newest)) continue;
    if (!Array.isArray(r.assets) || !r.assets.some((a) => a?.name === `rapthooker-${version}.tar.gz`)) continue;
    seen.add(version);
    const published = r.published_at ? Date.parse(r.published_at) : NaN;
    betas.push({
      version,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null,
      notes: typeof r.body === 'string' && r.body ? shorten(r.body, MAX_BETA_NOTES) : null,
      url: typeof r.html_url === 'string' ? r.html_url : `${RELEASES_URL}/tag/${r.tag_name}`,
      publishedAt: Number.isFinite(published) ? published : null,
    });
  }
  betas.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0) || (compareVersions(b.version, a.version) ?? 0));
  return betas.slice(0, MAX_BETAS);
}

/**
 * Checks GitHub for new releases (once a day, if enabled) and starts a self-update on hubs installed with install.sh.
 * A development build (deployed from source) isn't offered updates, but can be switched back to the latest release.
 * The owner can also try a beta (a pre-release, listed when asked for) and go back to the latest release from it.
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
  private savedBetas: SavedBetas | null = null;
  private pending: Pending | null = null;
  private state: UpdateInfo['state'] = 'idle';
  private failure: string | null = null;
  /** The version the last update was to install, when it didn't. */
  private failedTarget: string | null = null;
  private checking: Promise<UpdateInfo> | null = null;
  private checkingBetas: Promise<UpdateInfo> | null = null;
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
    const canSwitchToRelease = dev !== null && !this.fromSource && this.updaterReady();
    const prerelease = !dev && isBetaVersion(this.version);
    const betas = this.listedBetas();
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
      canSwitchToRelease,
      state: this.state,
      target: this.state === 'updating' ? this.pending?.version || null : this.state === 'failed' ? this.failedTarget : null,
      prerelease,
      canInstall: dev ? canSwitchToRelease : this.canSelfUpdate(),
      betas,
      betasCheckedAt: this.savedBetas?.checkedAt ?? null,
      betasError: this.savedBetas?.error ?? null,
      newerBeta: prerelease ? newestOfLine(betas, this.version) : null,
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

  /** Asks GitHub for the beta versions now. Never throws: problems end up in `betasError`. */
  async checkBetas(): Promise<UpdateInfo> {
    this.checkingBetas ??= this.fetchBetas()
      .then(() => {
        this.publish();
        return this.info();
      })
      .finally(() => {
        this.checkingBetas = null;
      });
    return this.checkingBetas;
  }

  /** The owner opened the list of betas: a repeat within half a minute gets the answer just fetched. */
  async checkBetasNow(): Promise<UpdateInfo> {
    const b = this.savedBetas;
    if (b && !b.error && this.now() - b.checkedAt < 30_000) return this.info();
    return this.checkBetas();
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

  /**
   * Installs a chosen release (the hub restarts): one of the betas, or the latest release, also when it's older than
   * the beta the hub runs (going back). Every release keeps working with the data any other has left (see
   * docs/data-compatibility.md), so this can go either way.
   */
  async install(version: string): Promise<UpdateInfo> {
    if (this.state === 'updating') return this.info();
    const wanted = version.trim().replace(/^v/, '');
    if (!INSTALLABLE.test(wanted)) throw new UpdateError(`"${version}" isn't a version like 0.9.0 or 0.9.0-beta.1.`, 400);
    const dev = this.devBuild();
    const ready = dev ? !this.fromSource && this.updaterReady() : this.canSelfUpdate();
    if (!this.dataDir || !ready) {
      throw new UpdateError("This hub can't install a release by itself. Run the installer on it instead (see the update instructions).");
    }
    if (!dev && wanted === this.version) throw new UpdateError(`This hub already runs RaptHooker ${wanted}.`);
    if (!this.offers(wanted)) {
      // The list may be out of date: look again before saying no.
      if (isBetaVersion(wanted)) await this.checkBetas();
      else await this.check();
      if (!this.offers(wanted)) {
        throw new UpdateError(
          `RaptHooker ${wanted} isn't a version this hub can install from here: only the latest release and the betas listed under Settings → Updates.`,
          404,
        );
      }
      // Another request may have started an update while GitHub was asked.
      if (this.updating()) return this.info();
    }
    return this.request(this.dataDir, wanted);
  }

  /** The latest release, or a beta that's listed. */
  private offers(version: string): boolean {
    return version === this.saved?.latest || this.listedBetas().some((b) => b.version === version);
  }

  /** Read through a method, so a check after an await isn't narrowed away by one before it. */
  private updating(): boolean {
    return this.state === 'updating';
  }

  /** The betas last fetched, without any the latest release has overtaken since. */
  private listedBetas(): BetaRelease[] {
    const latest = this.saved?.latest ?? null;
    const betas = this.savedBetas?.betas ?? [];
    return latest ? betas.filter((b) => isNewer(b.version, latest)) : betas;
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
    this.failedTarget = null;
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
    const betas = this.getMeta<SavedBetas>('update-betas');
    if (betas && typeof betas.checkedAt === 'number' && Array.isArray(betas.betas)) this.savedBetas = betas;
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

  /** A GET to GitHub's API, the way it asks to be asked. */
  private askGitHub(url: string): Promise<Response> {
    return this.fetchFn(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `RaptHooker/${this.version} (+https://github.com/${REPO})`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  private async runCheck(): Promise<UpdateInfo> {
    const now = this.now();
    const previous = this.saved;
    let next: SavedCheck;
    try {
      const res = await this.askGitHub(LATEST_RELEASE_API);
      if (res.status === 404) {
        next = { latest: null, notes: null, url: null, checkedAt: now, error: null, nextAt: now + DAY };
      } else if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        const at = Math.max(now + HOUR, Number.isFinite(reset) ? reset + MINUTE : 0, Number.isFinite(retryAfter) ? now + retryAfter : 0);
        next = this.failed(previous, now, RATE_LIMITED, Math.min(at, now + DAY));
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
      this.log.debug({ err: (err as Error).message }, 'update check failed');
      next = this.failed(previous, now, unreachable(err), now + HOUR);
    }
    this.saved = next;
    this.setMeta('update-check', JSON.stringify(next));
    // A hub on a beta hears about later betas too: one more question to GitHub a day.
    if (isBetaVersion(this.version) && !this.devBuild()) await this.fetchBetas();
    const info = this.info();
    if (info.available && previous?.latest !== next.latest)
      this.log.info({ current: this.version, latest: next.latest }, 'a new version is out');
    this.publish();
    return info;
  }

  /** Fetches the list of releases for the betas in it. Keeps the last list if GitHub can't be asked. */
  private async fetchBetas(): Promise<void> {
    const now = this.now();
    const previous = this.savedBetas?.betas ?? [];
    let next: SavedBetas;
    try {
      const res = await this.askGitHub(RELEASES_API);
      if (res.status === 404) next = { betas: [], checkedAt: now, error: null };
      else if (res.status === 403 || res.status === 429) {
        next = { betas: previous, checkedAt: now, error: 'GitHub is limiting how often it can be asked. Try again in an hour.' };
      } else if (!res.ok) next = { betas: previous, checkedAt: now, error: `GitHub answered ${res.status}. Try again later.` };
      else {
        const list = (await res.json()) as unknown;
        next = { betas: Array.isArray(list) ? betasFrom(list as Release[], this.saved?.latest ?? null) : [], checkedAt: now, error: null };
      }
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'checking for betas failed');
      next = { betas: previous, checkedAt: now, error: unreachable(err, false) };
    }
    this.savedBetas = next;
    this.setMeta('update-betas', JSON.stringify(next));
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
    const target = status.version || this.pending?.version || null;
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
      this.failedTarget = null;
      this.log.info({ from: status.from ?? null, to: status.version ?? this.version }, 'updated');
    } else {
      this.state = 'failed';
      this.failure = status.error?.trim() || "The update didn't work. The hub is still on the version it had.";
      this.failedTarget = target;
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

function unreachable(err: unknown, retries = true): string {
  const name = (err as Error).name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return retries ? "GitHub didn't answer in time. The hub will try again later." : "GitHub didn't answer in time. Try again later.";
  }
  return retries
    ? "Couldn't reach GitHub. Is the hub online? It will try again later."
    : "Couldn't reach GitHub. Is the hub online? Try again later.";
}

/** Markdown cut to at most `max` characters, at the end of a line. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return `${text.slice(0, cut > 0 ? cut : max).trimEnd()}\n\n…`;
}

/** The newest of `betas` that's a later beta of the same line as `current`. */
function newestOfLine(betas: BetaRelease[], current: string): string | null {
  let best: string | null = null;
  for (const b of betas) {
    if (sameLine(b.version, current) && isNewer(b.version, current) && (!best || isNewer(b.version, best))) best = b.version;
  }
  return best;
}
