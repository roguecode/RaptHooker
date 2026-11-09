import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_SCREEN_ITEMS,
  screenModel,
  type FoundScreen,
  type HubAddress,
  type ScreenDevice,
  type ScreenFirmware,
  type ScreenLook,
  type ScreenManualStart,
  type ScreenOptions,
  type ScreenPatch,
  type ScreenSetupInput,
  type ScreenSetupProgress,
  type ScreenState,
  type ScreenUsbSetupInput,
  type UsbBoardId,
  type UsbStatus,
  type WifiNetwork,
  type WifiStatus,
} from '@rapthooker/shared';
import type { Store } from '../db.js';
import type { Logger } from '../log.js';
import type { Settings } from '../settings.js';
import { ScreenClient, ScreenRequestError, type ScreenInfo } from './client.js';
import { compareVersions, imageMarker, imageProblems, md5, type FirmwareImage } from './firmware.js';
import { ScreenSetup } from './setup.js';
import { UsbSetup } from './usb/setup.js';
import type { UsbFlasher } from './usb/types.js';
import type { WifiController } from './wifi/types.js';

export class ScreenError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** A screen as saved (the `json` column of `screens`). Fields only get added; upgradeScreen fills in older saves. */
export interface SavedScreen {
  name: string;
  model: string;
  mac: string;
  hostname: string;
  /** The screen's key for its API (given to it at set-up). */
  token: string;
  pillId: string | null;
  look: ScreenLook;
  interval: number;
  brightness: number;
  firmware: string | null;
  ip: string | null;
  /** The picture address the screen was last given. */
  imageUrl: string | null;
  /** It has proved it has its key (firmware with "proof"), so it always has to from now on. */
  proof: boolean;
  /** Corrections to its panel (SCREEN_PANEL bits), for models with `panel`. */
  panel: number;
}

/** Fills in what an older save hasn't got. */
export function upgradeScreen(raw: Record<string, unknown>, units: Pick<ScreenLook, 'gravity' | 'temperature'>): SavedScreen {
  const look = (raw.look && typeof raw.look === 'object' ? raw.look : {}) as Partial<ScreenLook>;
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    name: str(raw.name, 'Screen'),
    model: str(raw.model, 'sdpro-240'),
    mac: str(raw.mac, ''),
    hostname: str(raw.hostname, ''),
    token: str(raw.token, ''),
    pillId: typeof raw.pillId === 'string' ? raw.pillId : null,
    look: { ...defaultLook(units), ...look },
    interval: num(raw.interval, 60),
    brightness: num(raw.brightness, 80),
    firmware: typeof raw.firmware === 'string' ? raw.firmware : null,
    ip: typeof raw.ip === 'string' ? raw.ip : null,
    imageUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : null,
    proof: raw.proof === true,
    panel: num(raw.panel, 0),
  };
}

export function defaultLook(units: Pick<ScreenLook, 'gravity' | 'temperature'>): ScreenLook {
  return {
    theme: 'dark',
    palette: 'violet',
    show: [...DEFAULT_SCREEN_ITEMS],
    range: 'brew',
    gravity: units.gravity,
    temperature: units.temperature,
    // The hub's.
    gravityDecimals: null,
    temperatureDecimals: null,
    lang: 'en',
    tz: null,
    brewing: false,
    // The hub's own screens show it, those set up before it could be too.
    alerts: true,
  };
}

interface Telemetry {
  lastSeenAt: number;
  rssi: number | null;
  uptime: number | null;
  failures: number | null;
}

/** A pending set-up done from a browser (for hubs that can't switch Wi-Fi). */
interface Pending {
  token: string;
  name: string;
  pillId: string | null;
  look: Partial<ScreenLook>;
  until: number;
}

export interface ScreenManagerDeps {
  store: Store;
  settings: Settings;
  log: Logger;
  wifi: WifiController;
  /** Boards plugged into the hub's USB. */
  usb: UsbFlasher;
  firmware: Map<string, FirmwareImage>;
  /** The hub's addresses (system.addresses). */
  addresses: () => Promise<HubAddress[]>;
  /** A screen's address from its mDNS name. */
  lookup: (hostname: string) => Promise<string | null>;
  /** Screens heard on the network. */
  browse: () => Promise<FoundScreen[]>;
  /** Something else (setting an iSpindel up) has the hub's Wi-Fi. */
  wifiBusy?: () => boolean;
  now?: () => number;
  /** Shorter waits (tests). */
  fast?: boolean;
}

const MINUTE = 60_000;
const CHECK_MS = 5 * MINUTE;
const BROWSE_MS = 30 * MINUTE;

/**
 * The hub's screens: their settings, how they're doing (from the picture requests they make), setting new ones up,
 * keeping their firmware and picture address up to date. Emits 'screen' (ScreenDevice), 'removed' (id),
 * 'setup' (ScreenSetupProgress) and 'found' (FoundScreen[]).
 */
export class ScreenManager extends EventEmitter {
  private screens = new Map<string, { saved: SavedScreen; raw: Record<string, unknown>; createdAt: number }>();
  private readonly telemetry = new Map<string, Telemetry>();
  private readonly updating = new Set<string>();
  private readonly errors = new Map<string, string>();
  /** Screens whose settings the hub couldn't send yet. */
  private readonly dirty = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private job: ScreenSetup | UsbSetup | null = null;
  private lastSetup: ScreenSetupProgress | null = null;
  private foundList: FoundScreen[] = [];
  private timers: NodeJS.Timeout[] = [];
  private lastState = new Map<string, ScreenState>();
  /** Talking to one screen happens one thing at a time, so a slow check can't send settings a patch has replaced. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly deps: ScreenManagerDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  private get db() {
    return this.deps.store.db;
  }

  private units() {
    const u = this.deps.settings.units();
    return { gravity: u.gravity, temperature: u.temperature };
  }

  load(): void {
    this.screens.clear();
    const rows = this.db.prepare('SELECT id, json, created_at FROM screens ORDER BY created_at').all() as unknown as {
      id: string;
      json: string;
      created_at: number;
    }[];
    for (const row of rows) {
      try {
        const raw = JSON.parse(row.json) as Record<string, unknown>;
        this.screens.set(row.id, { raw, saved: upgradeScreen(raw, this.units()), createdAt: row.created_at });
      } catch (err) {
        this.deps.log.error({ id: row.id, err: (err as Error).message }, 'skipped a screen that could not be read');
      }
    }
  }

  /** Stops keepConnected, while it runs. */
  private stopKeepingConnected: (() => void) | null = null;

  start(): void {
    this.stopKeepingConnected = this.deps.wifi.keepConnected?.() ?? null;
    // A restart in the middle of a set-up mustn't leave the hub on a screen's hotspot.
    void this.deps.wifi.recover().catch(() => undefined);
    this.timers.push(setInterval(() => this.tickStates(), MINUTE));
    this.timers.push(setInterval(() => void this.check(), CHECK_MS));
    this.timers.push(setInterval(() => void this.discover().catch(() => undefined), BROWSE_MS));
    for (const t of this.timers) t.unref();
    setTimeout(() => void this.check(), 20_000).unref();
    setTimeout(() => void this.discover().catch(() => undefined), 30_000).unref();
  }

  stop(): void {
    this.stopKeepingConnected?.();
    this.stopKeepingConnected = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** This hub's id, which screens keep so they know whose they are. */
  hubId(): string {
    let id = this.deps.store.getMeta('hubId');
    if (!id) {
      id = randomBytes(8).toString('hex');
      this.deps.store.setMeta('hubId', id);
    }
    return id;
  }

  firmwareFor(model: string): ScreenFirmware | null {
    const fw = this.deps.firmware.get(model);
    return fw ? { model: fw.model, version: fw.version, size: fw.size, md5: fw.md5 } : null;
  }

  firmwareImage(model: string): FirmwareImage | null {
    return this.deps.firmware.get(model) ?? null;
  }

  // ---- what the app sees

  list(): ScreenDevice[] {
    return [...this.screens.keys()].map((id) => this.device(id)!);
  }

  get(id: string): ScreenDevice | null {
    return this.screens.has(id) ? this.device(id) : null;
  }

  private state(id: string, interval: number): ScreenState {
    const t = this.telemetry.get(id);
    if (!t) return 'unknown';
    const age = this.now() - t.lastSeenAt;
    if (age < interval * 3_000 + 30_000) return 'online';
    if (age < Math.max(interval * 10_000, 15 * MINUTE)) return 'late';
    return 'offline';
  }

  private device(id: string): ScreenDevice | null {
    const entry = this.screens.get(id);
    if (!entry) return null;
    const s = entry.saved;
    const t = this.telemetry.get(id);
    const fw = this.deps.firmware.get(s.model);
    return {
      id,
      name: s.name,
      model: s.model,
      mac: s.mac,
      hostname: s.hostname,
      ip: s.ip,
      pillId: s.pillId,
      look: { ...s.look },
      interval: s.interval,
      brightness: s.brightness,
      firmware: s.firmware,
      panel: screenModel(s.model)?.panel ? s.panel : null,
      createdAt: entry.createdAt,
      status: {
        state: this.state(id, s.interval),
        lastSeenAt: t?.lastSeenAt ?? null,
        rssi: t?.rssi ?? null,
        uptime: t?.uptime ?? null,
        failures: t?.failures ?? null,
        update: fw && s.firmware && compareVersions(s.firmware, fw.version) < 0 ? fw.version : null,
        updating: this.updating.has(id),
        error: this.errors.get(id) ?? null,
      },
    };
  }

  private changed(id: string): void {
    const d = this.device(id);
    if (d) {
      this.lastState.set(id, d.status.state);
      this.emit('screen', d);
    }
  }

  private tickStates(): void {
    for (const [id, entry] of this.screens) {
      const state = this.state(id, entry.saved.interval);
      if (this.lastState.get(id) !== state) this.changed(id);
    }
  }

  // ---- saving

  private write(id: string, saved: SavedScreen, raw: Record<string, unknown>, createdAt?: number): void {
    // Over what's saved, so fields a newer version added stay.
    const json = { ...raw, ...saved };
    if (this.screens.has(id)) {
      this.db.prepare('UPDATE screens SET json = ? WHERE id = ?').run(JSON.stringify(json), id);
      this.screens.set(id, { saved, raw: json, createdAt: this.screens.get(id)!.createdAt });
    } else {
      const at = createdAt ?? this.now();
      this.db.prepare('INSERT INTO screens (id, json, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(json), at);
      this.screens.set(id, { saved, raw: json, createdAt: at });
    }
  }

  private add(
    info: Pick<ScreenInfo, 'id' | 'model' | 'mac' | 'hostname' | 'version'>,
    token: string,
    ip: string | null,
    opts: { name: string; pillId: string | null; look: Partial<ScreenLook> },
  ): string {
    const old = this.screens.get(info.id);
    const saved: SavedScreen = {
      ...(old?.saved ?? upgradeScreen({}, this.units())),
      name: opts.name,
      model: info.model,
      mac: info.mac,
      hostname: info.hostname,
      token,
      pillId: opts.pillId,
      look: { ...(old?.saved.look ?? defaultLook(this.units())), ...opts.look },
      firmware: info.version || old?.saved.firmware || null,
      ip,
    };
    this.write(info.id, saved, old?.raw ?? {});
    this.errors.delete(info.id);
    this.dirty.add(info.id);
    this.changed(info.id);
    // Heard on the network before it was added (over USB, say): it's not "found" any more.
    if (this.foundList.some((f) => f.id === info.id)) this.emit('found', this.found());
    void this.check([info.id]);
    return info.id;
  }

  // ---- talking to screens

  /**
   * A client for the screen at an address that has proved it has the screen's key: where it was last, else where its
   * mDNS name points. The key is only ever sent to such an address, so nobody can have the hub send it elsewhere (by
   * faking a screen's picture requests or its mDNS answers, say). A screen that has proved itself once has to every
   * time; one on firmware too old to (no "proof") is taken at its word until it's updated.
   */
  private async trusted(id: string): Promise<{ client: ScreenClient; info: ScreenInfo }> {
    const s = this.screens.get(id)?.saved;
    if (!s) throw new ScreenError('Unknown screen', 404);
    const hosts = [s.ip, await this.deps.lookup(s.hostname).catch(() => null)].filter((h, i, a): h is string => !!h && a.indexOf(h) === i);
    if (!hosts.length) throw new ScreenError("The hub doesn't know where this screen is yet", 409);
    let last: Error | null = null;
    for (const host of hosts) {
      const client = new ScreenClient(host, s.token);
      try {
        const { info, proven } = await client.prove(id, 5000);
        if (!proven && s.proof) throw new ScreenRequestError("the screen there can't prove it has the hub's key", 401);
        const now = this.screens.get(id);
        if (now && (now.saved.ip !== host || (proven && !now.saved.proof))) {
          this.write(id, { ...now.saved, ip: host, proof: now.saved.proof || proven }, now.raw);
        }
        return { client, info };
      } catch (err) {
        last = err as Error;
        this.deps.log.debug({ id, host, err: last.message }, "couldn't reach a screen");
      }
    }
    throw last!;
  }

  /** The address to give a screen for its picture: the hub's LAN address, on the screen's subnet if it has several. */
  async imageUrl(id: string, near: string | null = this.screens.get(id)?.saved.ip ?? null): Promise<string | null> {
    const lan = (await this.deps.addresses()).filter((a) => a.kind === 'lan' && !a.url.includes('['));
    if (!lan.length) return null;
    const prefix = near ? near.split(':')[0]!.split('.').slice(0, 3).join('.') + '.' : null;
    const base = (prefix && lan.find((a) => new URL(a.url).hostname.startsWith(prefix))) || lan[0]!;
    return `${base.url}/api/screens/${id}/image.jpg`;
  }

  /**
   * Makes sure screens have the right settings and picture address (the hub's address can change), and that the hub
   * knows where they are: asks each one that isn't fetching pictures, or has settings waiting.
   */
  async check(ids: string[] = [...this.screens.keys()]): Promise<void> {
    for (const id of ids) await this.serial(id, () => this.checkOne(id));
  }

  private async checkOne(id: string): Promise<void> {
    const first = this.screens.get(id);
    if (!first || this.updating.has(id)) return;
    const url = await this.imageUrl(id).catch(() => null);
    const needs = this.dirty.has(id) || (url !== null && url !== first.saved.imageUrl) || this.state(id, first.saved.interval) !== 'online';
    if (!needs) return;
    try {
      const { client, info } = await this.trusted(id);
      const s = this.screens.get(id)?.saved;
      if (!s) return;
      const picture = (await this.imageUrl(id, client.host)) ?? s.imageUrl ?? '';
      if (this.dirty.has(id) || picture !== s.imageUrl || info.image.url !== picture) {
        await client.settings({ ...this.screenSettings(s), hub: this.hubId(), imageUrl: picture });
        await client.refresh().catch(() => undefined);
      }
      // Read again: what's saved may have changed while the screen was being asked.
      const now = this.screens.get(id);
      if (!now) return;
      this.write(id, { ...now.saved, ip: client.host, firmware: info.version, imageUrl: picture }, now.raw);
      this.dirty.delete(id);
      this.errors.delete(id);
      this.changed(id);
    } catch (err) {
      const status = (err as { status?: number | null }).status;
      if (status === 401) {
        this.errors.set(id, 'not-allowed');
        this.changed(id);
      }
    }
  }

  /** The settings the hub keeps for a screen and sends it when they change. */
  private screenSettings(s: SavedScreen): { name: string; interval: number; brightness: number; panel?: number } {
    return {
      name: s.name,
      interval: s.interval,
      brightness: s.brightness,
      ...(screenModel(s.model)?.panel ? { panel: s.panel } : {}),
    };
  }

  // ---- the picture (GET /api/screens/:id/image.jpg)

  /** What a screen's picture shows, as image options at its size. Null for a screen the hub doesn't know. */
  pictureOf(id: string): { pillId: string | null; options: ScreenOptions; interval: number } | null {
    const s = this.screens.get(id)?.saved;
    if (!s) return null;
    const model = screenModel(s.model);
    return { pillId: s.pillId, interval: s.interval, options: { ...s.look, width: model?.width ?? 240, height: model?.height ?? 240 } };
  }

  /** A screen fetched its picture: it's alive, and says how it's doing in its headers. */
  seen(id: string, headers: Record<string, string | string[] | undefined>, ip: string | null): void {
    const entry = this.screens.get(id);
    if (!entry || headers['x-screen-id'] !== id) return;
    const status = String(headers['x-screen-status'] ?? '');
    const field = (name: string) => {
      const m = new RegExp(`(?:^|;)${name}=(-?\\d+)`).exec(status);
      return m ? Number(m[1]) : null;
    };
    const first = !this.telemetry.has(id);
    const before = this.state(id, entry.saved.interval);
    this.telemetry.set(id, { lastSeenAt: this.now(), rssi: field('rssi'), uptime: field('up'), failures: field('fail') });
    const firmware = /\/([0-9][^\s/]*)$/.exec(String(headers['x-screen-firmware'] ?? ''))?.[1] ?? null;
    const host = ip?.replace(/^::ffff:/, '') ?? null;
    if ((firmware && firmware !== entry.saved.firmware) || (host && host !== entry.saved.ip && !entry.saved.ip?.includes(':'))) {
      this.write(id, { ...entry.saved, firmware: firmware ?? entry.saved.firmware, ip: host ?? entry.saved.ip }, entry.raw);
    }
    this.errors.delete(id);
    if (first || before !== 'online') this.changed(id);
    else this.emit('screen', this.device(id));
  }

  // ---- changing a screen

  async patch(id: string, patch: ScreenPatch): Promise<ScreenDevice> {
    const entry = this.screens.get(id);
    if (!entry) throw new ScreenError('Unknown screen', 404);
    const s = entry.saved;
    const next: SavedScreen = {
      ...s,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.pillId !== undefined ? { pillId: patch.pillId } : {}),
      ...(patch.interval !== undefined ? { interval: patch.interval } : {}),
      ...(patch.brightness !== undefined ? { brightness: patch.brightness } : {}),
      ...(patch.panel !== undefined && screenModel(s.model)?.panel ? { panel: patch.panel } : {}),
      look: { ...s.look, ...patch.look },
    };
    this.write(id, next, entry.raw);
    const toScreen = patch.name !== undefined || patch.interval !== undefined || patch.brightness !== undefined || next.panel !== s.panel;
    await this.serial(id, async () => {
      try {
        const cur = this.screens.get(id)?.saved ?? next;
        const { client } = await this.trusted(id);
        if (toScreen) await client.settings(this.screenSettings(cur));
        // A new look shows straight away rather than at the next refresh.
        await client.refresh();
        if (toScreen) this.dirty.delete(id);
      } catch (err) {
        if (toScreen) this.dirty.add(id);
        this.deps.log.debug({ id, err: (err as Error).message }, 'screen not reached; its settings go when it is');
      }
    });
    this.changed(id);
    return this.device(id)!;
  }

  async action(id: string, what: 'identify' | 'refresh' | 'reboot' | 'test-pattern'): Promise<void> {
    const entry = this.screens.get(id);
    if (!entry) throw new ScreenError('Unknown screen', 404);
    if (what === 'test-pattern' && !screenModel(entry.saved.model)?.panel) throw new ScreenError('This screen has no test pattern');
    await this.serial(id, async () => {
      try {
        const { client } = await this.trusted(id);
        if (what === 'test-pattern') await client.testPattern(60);
        else await client[what]();
      } catch (err) {
        if (err instanceof ScreenError) throw err;
        throw new ScreenError(`The screen didn't answer: ${(err as Error).message}`, 502);
      }
    });
  }

  async log(id: string): Promise<string> {
    try {
      return await (await this.trusted(id)).client.log();
    } catch (err) {
      if (err instanceof ScreenError) throw err;
      throw new ScreenError(`The screen didn't answer: ${(err as Error).message}`, 502);
    }
  }

  /** Forgets a screen; with `reset`, first tells it to forget its settings (it goes back to its set-up hotspot). */
  async remove(id: string, reset: boolean): Promise<void> {
    if (!this.screens.has(id)) throw new ScreenError('Unknown screen', 404);
    if (reset) {
      try {
        await (await this.trusted(id)).client.reset();
      } catch (err) {
        throw new ScreenError(`The screen didn't answer, so it wasn't reset: ${(err as Error).message}`, 502);
      }
    }
    this.db.prepare('DELETE FROM screens WHERE id = ?').run(id);
    this.screens.delete(id);
    this.telemetry.delete(id);
    this.errors.delete(id);
    this.dirty.delete(id);
    this.emit('removed', id);
  }

  // ---- firmware

  /** Puts the hub's firmware on a screen and checks it came back with it. */
  async updateFirmware(id: string): Promise<ScreenDevice> {
    const entry = this.screens.get(id);
    if (!entry) throw new ScreenError('Unknown screen', 404);
    const fw = this.deps.firmware.get(entry.saved.model);
    if (!fw) throw new ScreenError('The hub has no firmware for this screen', 404);
    if (this.updating.has(id)) throw new ScreenError('Already updating', 409);
    this.updating.add(id);
    this.errors.delete(id);
    this.changed(id);
    try {
      await this.serial(id, async () => {
        const { client } = await this.trusted(id);
        await client.ota(fw.data, fw.md5);
        const until = this.now() + 120_000;
        let info: ScreenInfo | null = null;
        while (this.now() < until) {
          await new Promise((r) => setTimeout(r, this.deps.fast ? 20 : 3000));
          info = await client.info(4000).catch(() => null);
          if (info?.version === fw.version) break;
        }
        if (info?.version !== fw.version) throw new Error("It hasn't come back with the new firmware yet");
        const cur = this.screens.get(id);
        if (cur) this.write(id, { ...cur.saved, firmware: info.version }, cur.raw);
      });
      this.deps.log.info({ id, version: fw.version }, 'screen firmware updated');
    } catch (err) {
      this.errors.set(id, `update: ${(err as Error).message}`);
      throw new ScreenError(`The update didn't finish: ${(err as Error).message}`, 502);
    } finally {
      this.updating.delete(id);
      this.changed(id);
    }
    return this.device(id)!;
  }

  /** Updates every screen that needs it, one at a time. */
  async updateAll(): Promise<{ updated: string[]; failed: string[] }> {
    const updated: string[] = [];
    const failed: string[] = [];
    for (const d of this.list().filter((s) => s.status.update)) {
      try {
        await this.updateFirmware(d.id);
        updated.push(d.id);
      } catch {
        failed.push(d.id);
      }
    }
    return { updated, failed };
  }

  /**
   * Puts the screen's original firmware back (a file from its maker), then forgets the screen. Only a complete,
   * well-formed image is sent.
   */
  async restoreStock(id: string, data: Buffer): Promise<void> {
    const entry = this.screens.get(id);
    if (!entry) throw new ScreenError('Unknown screen', 404);
    if (screenModel(entry.saved.model)?.install !== 'hotspot') throw new ScreenError('This screen has no original firmware to put back');
    const problems = imageProblems(data);
    if (problems.length) throw new ScreenError(`That file isn't firmware the screen can take: ${problems.join(', ')}`);
    if (imageMarker(data)) throw new ScreenError("That's RaptHooker's own firmware, not the screen's original");
    if (data.length > 0x80000) throw new ScreenError('That file is too big for this screen');
    try {
      await (await this.trusted(id)).client.ota(data, md5(data), 1);
    } catch (err) {
      throw new ScreenError(`The screen didn't take it: ${(err as Error).message}`, 502);
    }
    this.deps.log.info({ id }, 'original firmware put back on a screen');
    await this.remove(id, false);
  }

  // ---- setting up

  wifiStatus(): Promise<WifiStatus> {
    return this.deps.wifi.status();
  }

  scan(): Promise<WifiNetwork[]> {
    return this.deps.wifi.scan();
  }

  setupProgress(): ScreenSetupProgress | null {
    return this.job?.snapshot() ?? this.lastSetup;
  }

  /** A screen is being set up (the hub's Wi-Fi may be on its hotspot). */
  busy(): boolean {
    return this.job !== null;
  }

  /** Starts setting a screen up; follow it with setupProgress or the 'setup' events. */
  startSetup(input: ScreenSetupInput): ScreenSetupProgress {
    if (this.job) throw new ScreenError('A screen is already being set up', 409);
    if (this.deps.wifiBusy?.()) throw new ScreenError("The hub's Wi-Fi is busy setting up an iSpindel: try again when it's done", 409);
    // The picture address is the hub's own on its network, so it's worked out before the hub leaves it.
    let addresses: HubAddress[] = [];
    const job = new ScreenSetup(input, {
      wifi: this.deps.wifi,
      firmware: this.deps.firmware,
      hubId: () => this.hubId(),
      imageUrl: (id) => this.urlFrom(addresses, id),
      tokenOf: (id) => this.screens.get(id)?.saved.token ?? null,
      lookup: this.deps.lookup,
      save: ({ info, token, ip }) => this.add(info, token, ip, { name: input.name, pillId: input.pillId, look: input.look }),
      log: this.deps.log,
      now: this.now,
      fast: this.deps.fast,
    });
    this.track(job, (list) => {
      addresses = list;
    });
    return job.snapshot();
  }

  /**
   * Boards plugged into the hub's USB, and whether the hub can set them up. Each likely board is asked which screen it
   * is (without restarting it), so ones already set up can be told from new ones; not the one a set-up is using.
   */
  async usbStatus(): Promise<UsbStatus> {
    const status = await this.deps.usb.status();
    const busy = this.job instanceof UsbSetup ? this.job.port : null;
    const ask = status.canSetUp ? status.ports.filter((p) => p.likely && p.path !== busy).map((p) => p.path) : [];
    const boards = ask.length ? await this.deps.usb.whois(ask).catch(() => new Map<string, UsbBoardId>()) : new Map<string, UsbBoardId>();
    return { ...status, ports: status.ports.map((p) => ({ ...p, board: boards.get(p.path) ?? null })) };
  }

  /** Starts setting up a board plugged into the hub's USB; follow it like startSetup. */
  startUsbSetup(input: ScreenUsbSetupInput): ScreenSetupProgress {
    if (this.job) throw new ScreenError('A screen is already being set up', 409);
    let addresses: HubAddress[] = [];
    const job = new UsbSetup(input, {
      usb: this.deps.usb,
      wifi: this.deps.wifi,
      firmware: this.deps.firmware,
      hubId: () => this.hubId(),
      imageUrl: (id) => this.urlFrom(addresses, id),
      known: (id) => {
        const s = this.screens.get(id)?.saved;
        return s ? { token: s.token, panel: s.panel } : null;
      },
      lookup: this.deps.lookup,
      save: ({ info, token, ip }) => this.add(info, token, ip, { name: input.name, pillId: input.pillId, look: input.look }),
      log: this.deps.log,
      now: this.now,
      fast: this.deps.fast,
    });
    this.track(job, (list) => {
      addresses = list;
    });
    return job.snapshot();
  }

  /**
   * Runs a set-up job (once the hub's addresses are known) and passes its progress on. The job is over, and another
   * may start, before its last progress goes out.
   */
  private track(job: ScreenSetup | UsbSetup, gotAddresses: (list: HubAddress[]) => void): void {
    this.job = job;
    job.on('progress', (p: ScreenSetupProgress) => {
      if (p.state !== 'running' && this.job === job) {
        this.lastSetup = p;
        this.job = null;
      }
      this.emit('setup', p);
    });
    void this.deps
      .addresses()
      .then(gotAddresses)
      .catch(() => undefined)
      .then(() => job.run())
      .catch((err: Error) => this.deps.log.error({ err: err.message }, 'screen set-up crashed'));
  }

  private urlFrom(addresses: HubAddress[], id: string): string | null {
    const lan = addresses.find((a) => a.kind === 'lan' && !a.url.includes('['));
    return lan ? `${lan.url}/api/screens/${id}/image.jpg` : null;
  }

  // ---- screens found on the network

  found(): FoundScreen[] {
    return this.foundList.filter((f) => !this.screens.has(f.id));
  }

  async discover(): Promise<FoundScreen[]> {
    this.foundList = await this.deps.browse();
    // A known screen at a new address: the hub follows it.
    for (const f of this.foundList) {
      const entry = this.screens.get(f.id);
      if (entry && entry.saved.ip !== f.ip) this.write(f.id, { ...entry.saved, ip: f.ip }, entry.raw);
    }
    this.emit('found', this.found());
    return this.found();
  }

  /**
   * Adds a screen heard on the network. One that isn't anyone's is just set up; one another hub (or a lost database)
   * has needs the code it shows: without `code`, it's asked to show one.
   */
  async adopt(
    id: string,
    code: string | undefined,
    name: string | undefined,
    look: Partial<ScreenLook> = {},
  ): Promise<{ screen: ScreenDevice | null; needsCode: boolean }> {
    const f = this.foundList.find((x) => x.id === id);
    if (!f) throw new ScreenError("That screen hasn't been heard on the network", 404);
    const client = new ScreenClient(f.ip);
    const info = await client.info().catch((err: Error) => {
      throw new ScreenError(`The screen didn't answer: ${err.message}`, 502);
    });
    if (!code) {
      await client.showCode().catch((err: Error) => {
        throw new ScreenError(`The screen didn't answer: ${err.message}`, 502);
      });
      return { screen: null, needsCode: true };
    }
    const token = randomBytes(16).toString('hex');
    const imageUrl = (await this.imageUrl(id, f.ip)) ?? undefined;
    try {
      await client.adopt({ code, token, hub: this.hubId(), name: name ?? (info.name || 'Screen'), imageUrl });
    } catch (err) {
      const status = (err as { status?: number | null }).status;
      throw new ScreenError(
        status === 403 ? 'wrong-code' : `The screen didn't answer: ${(err as Error).message}`,
        status === 403 ? 403 : 502,
      );
    }
    this.add(info, token, f.ip, { name: name ?? (info.name || 'Screen'), pillId: null, look });
    this.foundList = this.foundList.filter((x) => x.id !== id);
    this.emit('found', this.found());
    return { screen: this.device(id), needsCode: false };
  }

  // ---- set-up from the browser

  /** The hub's half of a set-up done from a browser: a key for the screen, and where to send it for its picture. */
  async manualStart(input: { name: string; pillId: string | null; look: Partial<ScreenLook> }): Promise<ScreenManualStart> {
    for (const [k, p] of this.pending) if (p.until < this.now()) this.pending.delete(k);
    const pending = randomBytes(8).toString('hex');
    const token = randomBytes(16).toString('hex');
    this.pending.set(pending, { token, ...input, until: this.now() + 2 * 60 * MINUTE });
    const lan = (await this.deps.addresses()).find((a) => a.kind === 'lan' && !a.url.includes('['));
    const firmware = [...this.deps.firmware.values()].map((fw) => ({ model: fw.model, version: fw.version, size: fw.size, md5: fw.md5 }));
    return { pending, token, hub: this.hubId(), imageBase: lan ? `${lan.url}/api/screens/` : null, firmware };
  }

  /** The browser has set the screen up: save it with the key it was given. */
  manualDone(input: { pending: string; id: string; model: string; ip: string | null }): ScreenDevice {
    const p = this.pending.get(input.pending);
    if (!p || p.until < this.now()) throw new ScreenError('That set-up has expired: start it again', 410);
    this.pending.delete(input.pending);
    const hex = input.id.toUpperCase();
    const mac = hex.match(/../g)!.join(':');
    this.add({ id: input.id, model: input.model, mac, hostname: `rh-screen-${input.id.slice(-6)}`, version: '' }, p.token, input.ip, p);
    return this.device(input.id)!;
  }
}
