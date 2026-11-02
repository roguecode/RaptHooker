import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  screenModel,
  type ScreenSetupError,
  type ScreenSetupProgress,
  type ScreenSetupStep,
  type ScreenUsbSetupInput,
} from '@rapthooker/shared';
import type { Logger } from '../../log.js';
import { ScreenClient, type ScreenInfo } from '../client.js';
import { ESP32_APP_AT, ESP32_BOOT_AT, ESP32_SETTINGS_AT, type FirmwareImage } from '../firmware.js';
import { SetupError } from '../setup.js';
import type { WifiController } from '../wifi/types.js';
import { settingsSector } from './sector.js';
import { UsbError, type UsbFlasher } from './types.js';

export interface UsbSetupDeps {
  usb: UsbFlasher;
  /** For the hub's own Wi-Fi password, when the screen joins the hub's network and none was typed. */
  wifi: WifiController;
  firmware: Map<string, FirmwareImage>;
  hubId: () => string;
  /** The picture address for a screen, as the hub can be reached on its own network. */
  imageUrl: (screenId: string) => string | null;
  /** A screen the hub has already: its key and panel corrections carry over. */
  known: (screenId: string) => { token: string; panel: number } | null;
  /** Looks for a screen on the network by its mDNS name; its address or null. */
  lookup: (hostname: string) => Promise<string | null>;
  /** Saves the screen once it's on the network; returns its id. */
  save: (screen: { info: ScreenInfo; token: string; ip: string | null }) => string;
  log: Logger;
  now?: () => number;
  /** Shortens the waits (tests). */
  fast?: boolean;
}

const USB_ERRORS: Record<UsbError['code'], ScreenSetupError> = {
  busy: 'usb-busy',
  denied: 'no-usb',
  'no-board': 'usb-failed',
  failed: 'usb-failed',
};

/** What the firmware printed as it started (firmware/screen/src: main.cpp, store.cpp, net.cpp). */
interface Seen {
  firmware: { model: string; version: string } | null;
  ip: string | null;
  joined: boolean;
  wrongPassword: number;
  notFound: number;
  noSettings: boolean;
  reason: string | null;
}

/**
 * Sets up a board plugged into the hub's USB: checks it's the chip its firmware is for, writes the boot loader,
 * partition table, firmware and its settings (Wi-Fi, key, picture address) in one go, restarts it and reads what it
 * prints to see it join the network, then finds it there and saves it. The hub never leaves its own network.
 *
 * Emits 'progress' (ScreenSetupProgress) at every step.
 */
export class UsbSetup extends EventEmitter {
  readonly progress: ScreenSetupProgress;
  private readonly now: () => number;

  constructor(
    private readonly input: ScreenUsbSetupInput,
    private readonly deps: UsbSetupDeps,
  ) {
    super();
    this.now = deps.now ?? Date.now;
    const at = this.now();
    this.progress = {
      id: randomBytes(6).toString('hex'),
      via: 'usb',
      hotspot: input.port,
      step: 'identify',
      state: 'running',
      error: null,
      detail: null,
      screenId: null,
      hubBack: true,
      startedAt: at,
      updatedAt: at,
      steps: [{ step: 'identify', at }],
      percent: null,
    };
  }

  /** The port it's using, while it runs. */
  get port(): string | null {
    return this.progress.state === 'running' ? this.input.port : null;
  }

  snapshot(): ScreenSetupProgress {
    return { ...this.progress, steps: this.progress.steps.map((s) => ({ ...s })) };
  }

  private step(step: ScreenSetupStep): void {
    const at = this.now();
    Object.assign(this.progress, { step, updatedAt: at, percent: null });
    this.progress.steps.push({ step, at });
    this.deps.log.info({ step, port: this.input.port }, 'screen set-up over USB');
    this.emit('progress', this.snapshot());
  }

  private ms(ms: number): number {
    return this.deps.fast ? Math.min(ms, 3000) : ms;
  }

  private async usb<T>(what: () => Promise<T>): Promise<T> {
    try {
      return await what();
    } catch (err) {
      if (err instanceof UsbError) throw new SetupError(USB_ERRORS[err.code], err.code === 'denied' ? 'not-allowed' : err.message);
      throw new SetupError('usb-failed', (err as Error).message);
    }
  }

  async run(): Promise<ScreenSetupProgress> {
    const { usb, log } = this.deps;
    const input = this.input;
    try {
      const status = await usb.status();
      if (!status.canSetUp) throw new SetupError('no-usb', status.reason);
      const model = screenModel(input.model);
      const fw = this.deps.firmware.get(input.model);
      if (!model || model.install !== 'usb') throw new SetupError('not-supported', `RaptHooker doesn't set ${input.model} up over USB`);
      if (!fw?.boot) throw new SetupError('not-supported', `The hub has no firmware for ${model.name}`);
      let password = input.password;
      if (!password) {
        const wifi = await this.deps.wifi.status().catch(() => null);
        password = (wifi && input.ssid === wifi.ssid ? await this.deps.wifi.password(input.ssid).catch(() => null) : null) ?? '';
        if (!password) throw new SetupError('no-password');
      }

      const board = await this.usb(() => usb.identify(input.port));
      log.info({ port: input.port, chip: board.description, mac: board.mac, flashMb: board.flashMb }, 'board on USB');
      if (board.chip !== model.chip) throw new SetupError('wrong-board', board.description);
      if (board.flashMb !== null && board.flashMb < 4)
        throw new SetupError('wrong-board', `${board.description}, ${board.flashMb} MB flash`);
      const id = board.mac.replace(/:/g, '');
      const known = this.deps.known(id);
      const token = known?.token ?? randomBytes(16).toString('hex');
      const sector = settingsSector({
        v: 1,
        ssid: input.ssid,
        pass: password,
        token,
        hub: this.deps.hubId(),
        name: input.name,
        imageUrl: this.deps.imageUrl(id) ?? '',
        interval: 60,
        brightness: 80,
        panel: known?.panel ?? 0,
      });

      this.step('install');
      this.progress.percent = 0;
      // Everything, every time: a board that has run has changed its NVS and maybe which app it starts, so this puts it
      // back to a known state. The boot blob empties the NVS and starts app0.
      const regions = [
        { at: ESP32_BOOT_AT, data: fw.boot, name: 'boot' },
        { at: ESP32_APP_AT, data: fw.data, name: `firmware ${fw.version}` },
        { at: ESP32_SETTINGS_AT, data: sector, name: 'settings' },
      ];
      await this.usb(() =>
        usb.write(input.port, regions, (percent) => {
          this.progress.percent = percent;
          this.progress.updatedAt = this.now();
          this.emit('progress', this.snapshot());
        }),
      );

      this.step('restart');
      const seen = await this.watch(model.id);
      if (seen) {
        if (!seen.firmware) throw new SetupError('no-restart', "The board didn't start RaptHooker's firmware");
        if (seen.firmware.model !== model.id) throw new SetupError('install-failed', `It started ${seen.firmware.model}`);
        if (seen.noSettings) throw new SetupError('install-failed', "The firmware couldn't read its settings");
        if (!seen.ip) {
          if (seen.wrongPassword >= 2) throw new SetupError('wrong-password');
          if (seen.notFound >= 2) throw new SetupError('network-not-found');
          if (seen.joined) throw new SetupError('no-address');
          throw new SetupError('wifi-failed', seen.reason);
        }
      }

      this.step('find');
      // Generous: the network can take a while to pass a new device's packets (switches learning, a busy access point).
      const found = await this.find(id, `rh-screen-${id.slice(-6)}`, token, seen?.ip ?? null, this.ms(seen ? 90_000 : 120_000));
      if (!found) throw new SetupError('not-found', seen?.ip ?? null);
      this.progress.screenId = this.deps.save({ info: found.info, token, ip: found.host });
      this.progress.state = 'done';
      this.step('done');
    } catch (err) {
      const e = err instanceof SetupError ? err : new SetupError('failed', (err as Error).message);
      log.warn({ error: e.code, detail: e.detail, step: this.progress.step }, 'screen set-up over USB failed');
      Object.assign(this.progress, { state: 'failed', error: e.code, detail: e.detail, updatedAt: this.now(), percent: null });
    } finally {
      this.emit('progress', this.snapshot());
    }
    return this.snapshot();
  }

  /** Restarts the board and reads what it prints until it's on the network, or plainly can't get there. */
  private async watch(model: string): Promise<Seen | null> {
    const seen: Seen = { firmware: null, ip: null, joined: false, wrongPassword: 0, notFound: 0, noSettings: false, reason: null };
    const watched = await this.deps.usb
      .watch(this.input.port, this.ms(75_000), (line) => {
        const fw = /RHSCREEN-FW:([a-z0-9-]+):(\S+)/.exec(line);
        if (fw) {
          seen.firmware = { model: fw[1]!, version: fw[2]! };
          return fw[1] !== model;
        }
        if (/store: (no rhscreen partition|empty|bad checksum)/.test(line)) {
          seen.noSettings = true;
          return true;
        }
        if (/net: joining /.test(line) && this.progress.step !== 'wifi') this.step('wifi');
        if (/net: joined /.test(line)) seen.joined = true;
        const online = /net: online (\d+\.\d+\.\d+\.\d+(?::\d+)?)/.exec(line);
        if (online) {
          seen.ip = online[1]!;
          return true;
        }
        const reason = /net: (?:station disconnected, reason \d+ \(([^)]*)\)|still joining .*: (.+))$/.exec(line.trim());
        if (reason) {
          seen.reason = (reason[1] ?? reason[2] ?? '').trim() || seen.reason;
          if (/wrong password/.test(line)) seen.wrongPassword++;
          if (/network not found/.test(line)) seen.notFound++;
        }
        return seen.wrongPassword >= 2 || seen.notFound >= 2;
      })
      .catch((err: Error) => {
        this.deps.log.warn({ err: err.message }, "couldn't watch the board start");
        return false;
      });
    return watched ? seen : null;
  }

  /** The screen on the network, proving it has the key it was just given: where it said it was, else by its mDNS name. */
  private async find(
    id: string,
    hostname: string,
    token: string,
    ip: string | null,
    ms: number,
  ): Promise<{ host: string; info: ScreenInfo } | null> {
    const until = this.now() + ms;
    while (this.now() < until) {
      for (const host of [ip, await this.deps.lookup(hostname).catch(() => null)]) {
        if (!host) continue;
        const proved = await new ScreenClient(host, token).prove(id, 4000).catch(() => null);
        if (proved?.proven) return { host, info: proved.info };
      }
      await new Promise((r) => setTimeout(r, this.deps.fast ? 20 : 2000));
    }
    return null;
  }
}
