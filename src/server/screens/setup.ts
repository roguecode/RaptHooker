import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  GEEKMAGIC_ULTRA,
  hotspotKind,
  screenHotspot,
  screenTrialError,
  type ScreenSetupError,
  type ScreenSetupInput,
  type ScreenSetupProgress,
  type ScreenSetupStep,
  type StockKind,
  type WifiNetwork,
} from '@rapthooker/shared';
import type { Logger } from '../log.js';
import { ScreenClient, type ScreenInfo } from './client.js';
import { compareVersions, type FirmwareImage } from './firmware.js';
import { flashGeekmagic, flashStock, identifyGeekmagic, identifyStock } from './stock.js';
import type { HotspotLink, WifiController } from './wifi/types.js';

/** What the set-up needs from the rest of the hub. */
export interface SetupDeps {
  wifi: WifiController;
  firmware: Map<string, FirmwareImage>;
  hubId: () => string;
  /** The picture address for a screen, as the hub can be reached on its own network. */
  imageUrl: (screenId: string, near: string | null) => string | null;
  /** A screen's key, if the hub already has it (setting up a screen it knows again). */
  tokenOf: (screenId: string) => string | null;
  /** Looks for a screen on the network by its mDNS name; its address or null. */
  lookup: (hostname: string) => Promise<string | null>;
  /** Saves the screen once it's on the network; returns its id. */
  save: (screen: { info: ScreenInfo; token: string; ip: string | null; input: ScreenSetupInput }) => string;
  log: Logger;
  now?: () => number;
  /** Shortens the waits (tests). */
  fast?: boolean;
}

export class SetupError extends Error {
  constructor(
    readonly code: ScreenSetupError,
    readonly detail: string | null = null,
  ) {
    super(detail ?? code);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A screen on the firmware it came with, identified: RaptHooker's hotspot is named after `mac`, when it's known. */
interface Stock {
  kind: StockKind;
  model: string;
  mac: string | null;
}

/**
 * Sets a screen up from its hotspot: puts RaptHooker firmware on a stock screen, has the screen join the hub's
 * network (trying it while the hotspot stays up, so a wrong password is reported, not guessed), then finds it on the
 * network and saves it. The hub leaves its own Wi-Fi for this when it has no other connection, so the whole thing
 * runs here, and getting back on the network is in a `finally` that nothing skips.
 *
 * A GeekMagic Ultra that's on the hub's network already can be set up from its `address` instead: RaptHooker goes on
 * over the network, then the rest is done on RaptHooker's hotspot as for any other.
 *
 * Emits 'progress' (ScreenSetupProgress) at every step.
 */
export class ScreenSetup extends EventEmitter {
  readonly progress: ScreenSetupProgress;
  private readonly now: () => number;
  private link: HotspotLink | null = null;
  /** A join was tried: the hub may have left its network, even if the join then failed. */
  private left = false;

  constructor(
    private readonly input: ScreenSetupInput,
    private readonly deps: SetupDeps,
  ) {
    super();
    this.now = deps.now ?? Date.now;
    const at = this.now();
    // From an address, there's no hotspot to join first.
    const first: ScreenSetupStep = input.address ? 'identify' : 'hotspot';
    this.progress = {
      id: randomBytes(6).toString('hex'),
      via: 'wifi',
      hotspot: input.address ?? input.hotspot,
      step: first,
      state: 'running',
      error: null,
      detail: null,
      screenId: null,
      hubBack: true,
      startedAt: at,
      updatedAt: at,
      steps: [{ step: first, at }],
      percent: null,
    };
  }

  private step(step: ScreenSetupStep): void {
    const at = this.now();
    Object.assign(this.progress, { step, updatedAt: at });
    this.progress.steps.push({ step, at });
    this.deps.log.info({ step, hotspot: this.progress.hotspot }, 'screen set-up');
    this.emit('progress', this.snapshot());
  }

  snapshot(): ScreenSetupProgress {
    return { ...this.progress, steps: this.progress.steps.map((s) => ({ ...s })) };
  }

  private wait(ms: number): Promise<void> {
    return sleep(this.deps.fast ? Math.min(ms, 20) : ms);
  }

  /** How long to give something, shortened for tests. */
  private ms(ms: number): number {
    return this.deps.fast ? Math.min(ms, 2000) : ms;
  }

  private client(token: string | null = null): ScreenClient {
    return new ScreenClient(this.link!.screen, token, this.link!.address ?? undefined);
  }

  /** Joins a hotspot, trying for a while (a screen that's just restarted takes a few seconds to open it). */
  private async join(ssid: string, ms: number, error: ScreenSetupError): Promise<void> {
    this.left = true;
    try {
      this.link = await this.deps.wifi.join(ssid, this.ms(ms));
    } catch (err) {
      throw new SetupError(error, (err as Error).message);
    }
  }

  /**
   * RaptHooker's hotspot, once its firmware has gone on. When it doesn't come, says why: the stock hotspot is back
   * (the firmware didn't take), or the screen is on the hub's network already (RaptHooker had been on it before and
   * kept that set-up), or nobody knows.
   */
  private async joinInstalled(ours: string, hostname: string): Promise<void> {
    try {
      this.link = await this.deps.wifi.join(ours, this.ms(90_000));
      return;
    } catch (err) {
      const detail = (err as Error).message;
      const nets = await this.deps.wifi.scan().catch(() => []);
      if (nets.some((n) => n.ssid === this.input.hotspot))
        throw new SetupError('install-failed', 'The screen is still on its own firmware');
      await this.leave();
      if (await this.deps.lookup(hostname).catch(() => null)) throw new SetupError('on-network', hostname);
      throw new SetupError('no-restart', detail);
    }
  }

  /**
   * RaptHooker's hotspot on a screen that was a GeekMagic, once its firmware has gone on. GeekMagic's firmware doesn't
   * say its MAC address, which the hotspot is named after: on its own hotspot that's going by the hotspot's (the last
   * three bytes are the same on an ESP8266); from an address it's the RaptHooker hotspot that wasn't there before.
   * Returns the hotspot joined. When none comes, says why, as joinInstalled does.
   */
  private async joinGeekmagic(expected: string | null, before: Set<string>, still: () => Promise<boolean>): Promise<string> {
    let detail = 'No RaptHooker hotspot came up';
    if (expected) {
      try {
        this.left = true;
        this.link = await this.deps.wifi.join(expected, this.deps.fast ? 1000 : 60_000);
        return expected;
      } catch (err) {
        detail = (err as Error).message;
      }
    }
    const until = this.now() + this.ms(expected ? 45_000 : 90_000);
    while (this.now() < until) {
      const nets = await this.deps.wifi.scan().catch((): WifiNetwork[] => []);
      const fresh = [...new Set(nets.filter((n) => n.kind === 'rapthooker' && !before.has(n.ssid)).map((n) => n.ssid))];
      if (fresh.length === 1) {
        try {
          // Only once a join is tried: from an address the hub may not have left its network at all.
          this.left = true;
          this.link = await this.deps.wifi.join(fresh[0]!, this.ms(30_000));
          return fresh[0]!;
        } catch (err) {
          detail = (err as Error).message;
        }
      } else if (fresh.length > 1) detail = `More than one new RaptHooker screen is near: ${fresh.join(', ')}`;
      await this.wait(3000);
    }
    await this.leave();
    if (await still()) throw new SetupError('install-failed', 'The screen is still on its own firmware');
    const hostname = expected ? `rh-screen-${expected.slice(-6).toLowerCase()}` : null;
    if (hostname && (await this.deps.lookup(hostname).catch(() => null))) throw new SetupError('on-network', hostname);
    throw new SetupError('no-restart', detail);
  }

  /** Asks again until it answers (the hotspot can drop for a moment when the screen moves it to another channel). */
  private async ask<T>(what: () => Promise<T>, ms: number, rejoin: string | null): Promise<T> {
    const until = this.now() + ms;
    let last: Error | null = null;
    while (this.now() < until) {
      try {
        return await what();
      } catch (err) {
        last = err as Error;
        if ((err as { status?: number | null }).status) throw err;
        await this.wait(1500);
        if (rejoin) this.link = await this.deps.wifi.join(rejoin, 20_000).catch(() => this.link);
      }
    }
    throw last ?? new Error('no answer');
  }

  async run(): Promise<ScreenSetupProgress> {
    const { wifi, log } = this.deps;
    const input = this.input;
    try {
      const status = await wifi.status();
      if (!status.canSetUp) throw new SetupError('no-wifi-control', status.reason);
      let password = input.password;
      if (!password) {
        password = (input.ssid === status.ssid ? await wifi.password(input.ssid) : null) ?? '';
        if (!password) throw new SetupError('no-password');
      }
      // The channel the screen's network is on, while the hub can still see it: the screen moves its hotspot there
      // before joining, so the hub's link to it drops once, when expected. The hub's own channel only does when the hub
      // is on the network's 2.4 GHz band: a router can use the same name for its 5 GHz one, which screens can't use.
      const channel =
        input.ssid === status.ssid && status.band === 2.4 && status.channel ? status.channel : await this.channelOf(input.ssid);

      const lan = input.address ?? null;
      const kind = lan ? 'geekmagic' : hotspotKind(input.hotspot);
      // A GeekMagic's hotspot, and the RaptHooker hotspots already about, while the hub is still on its own network.
      let around: WifiNetwork[] = [];
      if (kind === 'geekmagic') around = await wifi.scan().catch((): WifiNetwork[] => []);
      if (!lan) {
        await this.join(input.hotspot, 45_000, 'hotspot-failed');
        this.step('identify');
      }
      const host = lan ?? this.link!.screen;
      const local = lan ? undefined : (this.link!.address ?? undefined);
      let info: ScreenInfo | null = null;
      let stock: Stock | null = null;
      if (kind === 'sdpro') {
        const sdpro = await identifyStock(host, local);
        if (sdpro) stock = { kind, model: sdpro.model, mac: sdpro.mac };
      } else if (kind === 'geekmagic') {
        const gm = await identifyGeekmagic(host, local);
        if (gm && gm.model !== GEEKMAGIC_ULTRA)
          throw new SetupError('not-supported', `This is a GeekMagic ${gm.model}: RaptHooker only knows the ${GEEKMAGIC_ULTRA}`);
        const bssid = lan
          ? null
          : (around.filter((n) => n.ssid === input.hotspot && n.bssid).sort((a, b) => b.signal - a.signal)[0]?.bssid ?? null);
        if (gm) stock = { kind, model: 'sdpro-240', mac: bssid };
      }
      if (!stock) {
        if (lan) throw new SetupError('not-supported', `No GeekMagic Ultra on its own firmware answered at ${lan}`);
        info = await this.client()
          .info()
          .catch(() => null);
        if (!info || info.firmware !== 'rapthooker-screen') throw new SetupError('not-supported', 'This isn’t a screen RaptHooker knows');
      }
      let ours = stock ? (stock.mac ? screenHotspot(stock.mac) : null) : screenHotspot(info!.mac);
      if (stock) {
        const fw = this.deps.firmware.get(stock.model);
        if (!fw) throw new SetupError('not-supported', `No firmware for ${stock.model}`);
        this.step('install');
        let confirmed: boolean;
        try {
          confirmed = await (stock.kind === 'sdpro' ? flashStock : flashGeekmagic)(host, fw, local);
        } catch (err) {
          throw new SetupError('install-failed', (err as Error).message);
        }
        log.info({ kind: stock.kind, mac: stock.mac, version: fw.version, confirmed }, 'RaptHooker firmware sent to a stock screen');
        this.step('restart');
        // It restarts, copies the firmware into place (it mustn't lose power now) and opens its own hotspot.
        await this.wait(8000);
        if (stock.kind === 'sdpro') {
          await this.joinInstalled(ours!, `rh-screen-${stock.mac!.replace(/:/g, '').slice(-6).toLowerCase()}`);
        } else {
          const before = new Set(around.filter((n) => n.kind === 'rapthooker').map((n) => n.ssid));
          ours = await this.joinGeekmagic(ours, before, async () =>
            lan
              ? (await identifyGeekmagic(lan)) !== null
              : (await this.deps.wifi.scan().catch((): WifiNetwork[] => [])).some((n) => n.ssid === input.hotspot),
          );
        }
        info = await this.ask(() => this.client().info(), 30_000, ours).catch((err: Error) => {
          throw new SetupError('screen-unreachable', err.message);
        });
        if (info.firmware !== 'rapthooker-screen') throw new SetupError('install-failed', 'The screen is still on its own firmware');
        if (info.version === fw.version && info.system.sketchMd5 !== fw.md5) {
          throw new SetupError('install-failed', 'The firmware on the screen isn’t the one sent');
        }
      }
      this.step('screen');
      info = info!;
      ours = screenHotspot(info.mac);
      let token = this.deps.tokenOf(info.id);
      if (info.claimed && !token) throw new SetupError('not-supported', 'claimed');
      // One the hub knows: it has to prove it has the key before the hub sends it (it could be a fake hotspot).
      if (info.claimed && token) {
        await this.client(token)
          .prove(info.id)
          .catch(() => {
            throw new SetupError('not-supported', 'claimed');
          });
      }
      // A screen on older firmware is brought up to date while it's close at hand.
      const fw = this.deps.firmware.get(info.model);
      if (fw && compareVersions(info.version, fw.version) < 0) {
        await this.client(token).ota(fw.data, fw.md5);
        await this.wait(8000);
        await this.join(ours, 90_000, 'no-restart');
        info = await this.ask(() => this.client(token).info(), 30_000, ours);
      }

      this.step('wifi');
      token ??= randomBytes(16).toString('hex');
      const imageUrl = this.deps.imageUrl(info.id, null) ?? '';
      if (info.claimed) {
        // One it knows, in its fallback hotspot: new Wi-Fi details, then it restarts and joins.
        await this.client(token).settings({ ssid: input.ssid, password, name: input.name, hub: this.deps.hubId(), imageUrl });
      } else {
        await this.client().setup({
          ssid: input.ssid,
          password,
          token,
          hub: this.deps.hubId(),
          name: input.name,
          imageUrl,
          interval: 60,
          brightness: 80,
          channel: channel ?? 0,
        });
      }
      let ip: string | null = null;
      if (!info.claimed) {
        const until = this.now() + 80_000;
        for (;;) {
          await this.wait(1500);
          const s = await this.client()
            .setupStatus()
            .catch(() => null);
          if (!s) {
            // The hotspot moved to the network's channel: join it again.
            this.link = await wifi.join(ours, 20_000).catch(() => this.link);
          } else if (s.trial === 'connected' && s.saved) {
            ip = s.ip ?? null;
            break;
          } else if (s.trial === 'failed') {
            throw new SetupError(screenTrialError(s.error), s.error);
          }
          if (this.now() > until) throw new SetupError('wifi-failed', 'The screen took too long to join the network');
        }
        await this.client(token)
          .finish()
          .catch((err: Error) => log.warn({ err: err.message }, 'screen set-up: finish not acknowledged'));
      }

      this.step('back');
      await this.leave();
      this.step('find');
      const found = await this.find(info, token, ip);
      if (!found) throw new SetupError('not-found', ip);
      this.progress.screenId = this.deps.save({ info, token, ip: found, input });
      this.progress.state = 'done';
      this.step('done');
    } catch (err) {
      const e = err instanceof SetupError ? err : new SetupError('failed', (err as Error).message);
      log.warn({ error: e.code, detail: e.detail, step: this.progress.step }, 'screen set-up failed');
      Object.assign(this.progress, { state: 'failed', error: e.code, detail: e.detail, updatedAt: this.now() });
    } finally {
      await this.leave();
      this.emit('progress', this.snapshot());
    }
    return this.snapshot();
  }

  /** Back on the hub's own network, whatever happened (a join that timed out may still have taken the hub off it). */
  private async leave(): Promise<void> {
    if (!this.link && !this.left) return;
    this.link = null;
    this.left = false;
    try {
      this.progress.hubBack = await this.deps.wifi.restore();
    } catch (err) {
      this.progress.hubBack = false;
      this.deps.log.error({ err: (err as Error).message }, 'screen set-up: could not get back on the network');
    }
  }

  private async channelOf(ssid: string): Promise<number | null> {
    const nets = await this.deps.wifi.scan().catch(() => []);
    return nets.filter((n) => n.ssid === ssid && n.band === 2.4).sort((a, b) => b.signal - a.signal)[0]?.channel ?? null;
  }

  /** The screen on the hub's network: at the address it reported, else by its mDNS name. */
  private async find(info: ScreenInfo, token: string, ip: string | null): Promise<string | null> {
    const until = this.now() + 90_000;
    while (this.now() < until) {
      for (const host of [ip, await this.deps.lookup(info.hostname).catch(() => null)]) {
        if (!host) continue;
        const seen = await new ScreenClient(host, token).info(4000).catch(() => null);
        if (seen?.id === info.id && seen.state === 'online') return host;
      }
      await this.wait(3000);
    }
    return null;
  }
}
