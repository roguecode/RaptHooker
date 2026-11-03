import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  IspindelServer,
  IspindelSetupError,
  IspindelSetupInput,
  IspindelSetupProgress,
  IspindelSetupStep,
  IspindelWritten,
} from '@rapthooker/shared';
import type { Logger } from '../log.js';
import type { HotspotLink, WifiController } from '../screens/wifi/types.js';
import { fieldValue, httpServiceNumber, isIspindelForm, readPortal, saveParams, savePortal, type PortalForm } from './portal.js';

/** What setting an iSpindel up needs from the rest of the hub. */
export interface IspindelSetupDeps {
  wifi: WifiController;
  /** Where the iSpindel should post, worked out while the hub is still on its network. */
  server: IspindelServer;
  /** The token it should send. */
  token: string;
  /** The chip id it will post as, if the hotspot's address gave it away. */
  chipId: string | null;
  /**
   * Waits up to `ms` for its first reading and adds it; the device's id, or null if none came (it's then added
   * whenever one does, for a while).
   */
  firstReading: (written: IspindelWritten, chipId: string | null, ms: number) => Promise<string | null>;
  log: Logger;
  now?: () => number;
  /** Shortens the waits (tests). */
  fast?: boolean;
}

export class IspindelSetupFailure extends Error {
  constructor(
    readonly code: IspindelSetupError,
    readonly detail: string | null = null,
  ) {
    super(detail ?? code);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sets an iSpindel up from its setup hotspot: joins it, reads its settings, and saves them back with the HTTP service
 * pointed at this hub (its address, port, path and the iSpindel token), the Wi-Fi it should use and how often to send.
 * Everything else it has (its calibration formula, battery factor, temperature unit…) is kept. The hub leaves its own
 * Wi-Fi for this when it has no other connection, so getting back on it is in a `finally` that nothing skips.
 *
 * Emits 'progress' (IspindelSetupProgress) at every step.
 */
export class IspindelSetup extends EventEmitter {
  readonly progress: IspindelSetupProgress;
  private readonly now: () => number;
  private link: HotspotLink | null = null;
  private left = false;

  constructor(
    private readonly input: IspindelSetupInput,
    private readonly deps: IspindelSetupDeps,
  ) {
    super();
    this.now = deps.now ?? Date.now;
    const at = this.now();
    this.progress = {
      id: randomBytes(6).toString('hex'),
      hotspot: input.hotspot,
      chipId: deps.chipId,
      step: 'hotspot',
      state: 'running',
      error: null,
      detail: null,
      deviceId: null,
      waiting: false,
      written: null,
      hubBack: true,
      startedAt: at,
      updatedAt: at,
      steps: [{ step: 'hotspot', at }],
    };
  }

  snapshot(): IspindelSetupProgress {
    return {
      ...this.progress,
      written: this.progress.written ? { ...this.progress.written } : null,
      steps: this.progress.steps.map((s) => ({ ...s })),
    };
  }

  private step(step: IspindelSetupStep): void {
    const at = this.now();
    Object.assign(this.progress, { step, updatedAt: at });
    this.progress.steps.push({ step, at });
    this.deps.log.info({ step, hotspot: this.input.hotspot }, 'iSpindel set-up');
    this.emit('progress', this.snapshot());
  }

  private ms(ms: number): number {
    return this.deps.fast ? Math.min(ms, 2000) : ms;
  }

  /** Reads the setup page, asking again for a while (the hotspot can take a moment to pass traffic once joined). */
  private async read(): Promise<PortalForm> {
    const until = this.now() + this.ms(30_000);
    let last: Error | null = null;
    while (this.now() < until) {
      try {
        return await readPortal(this.link!.screen, this.link!.address ?? undefined);
      } catch (err) {
        last = err as Error;
        await sleep(this.deps.fast ? 20 : 1500);
      }
    }
    throw new IspindelSetupFailure('hotspot-failed', last?.message ?? 'no answer');
  }

  private async leave(): Promise<void> {
    if (!this.left) return;
    this.left = false;
    this.progress.hubBack = await this.deps.wifi.restore().catch(() => false);
  }

  async run(): Promise<IspindelSetupProgress> {
    const { wifi, log, server } = this.deps;
    const input = this.input;
    try {
      const status = await wifi.status();
      if (!status.canSetUp) throw new IspindelSetupFailure('no-wifi-control', status.reason);
      if (!server.host) throw new IspindelSetupFailure('no-address');
      // The hub's own network's password, while the hub is still on it (it can't be asked from the hotspot).
      const hubPassword = input.ssid && !input.password && input.ssid === status.ssid ? await wifi.password(input.ssid) : null;

      this.left = true;
      try {
        this.link = await wifi.join(input.hotspot, this.ms(45_000));
      } catch (err) {
        throw new IspindelSetupFailure('hotspot-failed', (err as Error).message);
      }

      this.step('read');
      const form = await this.read();
      if (!isIspindelForm(form)) throw new IspindelSetupFailure('not-ispindel');
      const currentSsid = fieldValue(form, 's') ?? '';
      const changes: Record<string, string> = {
        sleep: String(input.interval),
        selAPI: String(httpServiceNumber(form)),
        token: this.deps.token,
        server: server.host,
        port: String(server.port),
        uri: server.path,
      };
      if (input.name) changes.name = input.name;
      if (input.ssid) {
        // Its own saved password still works for the network it already uses.
        const password = input.password || hubPassword || (input.ssid === currentSsid ? (fieldValue(form, 'p') ?? '') : '');
        if (!password && (input.ssid === status.ssid || input.ssid === currentSsid)) throw new IspindelSetupFailure('no-password');
        changes.s = input.ssid;
        changes.p = password;
      } else if (!currentSsid) {
        throw new IspindelSetupFailure('no-password', 'It has no Wi-Fi network yet: choose one');
      }
      const written: IspindelWritten = {
        name: input.name || fieldValue(form, 'name') || 'iSpindel',
        ssid: input.ssid || currentSsid,
        server: server.host,
        port: server.port,
        path: server.path,
        interval: input.interval,
      };
      this.progress.written = written;

      this.step('configure');
      try {
        await savePortal(this.link!.screen, saveParams(form, changes, ['usehttps', 'hassio']), this.link!.address ?? undefined);
      } catch (err) {
        // It closes its hotspot as soon as it has the settings: a reply lost after the request went still saved them.
        if (!(err as { sent?: boolean }).sent) throw new IspindelSetupFailure('save-failed', (err as Error).message);
        log.info({ err: (err as Error).message }, 'no reply after sending an iSpindel its settings; taking them as saved');
      }
      log.info(
        { hotspot: input.hotspot, ssid: written.ssid, server: `${written.server}:${written.port}${written.path}` },
        'iSpindel set up',
      );

      this.step('back');
      await this.leave();

      this.step('reading');
      const deviceId = await this.deps.firstReading(written, this.deps.chipId, this.ms(120_000));
      this.progress.deviceId = deviceId;
      this.progress.waiting = deviceId === null;
      this.progress.state = 'done';
      this.step('done');
    } catch (err) {
      const failure = err instanceof IspindelSetupFailure ? err : new IspindelSetupFailure('save-failed', (err as Error).message);
      this.progress.state = 'failed';
      this.progress.error = failure.code;
      this.progress.detail = failure.detail;
      log.warn({ code: failure.code, detail: failure.detail, hotspot: input.hotspot }, 'iSpindel set-up failed');
      await this.leave();
      this.progress.updatedAt = this.now();
      this.emit('progress', this.snapshot());
    } finally {
      await this.leave();
    }
    return this.snapshot();
  }
}
