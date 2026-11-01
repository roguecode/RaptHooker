import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type * as DbusNext from 'dbus-next';
import type { MessageBus } from 'dbus-next';
import { hotspotKind, type WifiNetwork, type WifiStatus } from '@rapthooker/shared';
import type { Logger } from '../../log.js';
import { bandOf, channelOf, tidyNetworks, type HotspotLink, type WifiController } from './types.js';

type Dbus = Pick<typeof DbusNext, 'systemBus' | 'Message' | 'Variant'>;

const NM = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
const SETTINGS_PATH = '/org/freedesktop/NetworkManager/Settings';
const PROPS = 'org.freedesktop.DBus.Properties';
const DEVICE = `${NM}.Device`;
const WIRELESS = `${NM}.Device.Wireless`;
const ACTIVE = `${NM}.Connection.Active`;
const CONNECTION = `${NM}.Settings.Connection`;
const DEVICE_WIFI = 2;
const ACTIVATED = 2;
const DEACTIVATED = 4;
const CALL_TIMEOUT_MS = 15_000;
/** The temporary connections' name, so a leftover one can be found and removed. */
const TEMP_ID = 'rapthooker-screen-setup';
/** Where both the stock and RaptHooker firmware answer on their hotspots. */
const SCREEN_ADDRESS = '192.168.4.1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// dbus-next gives variants as { signature, value }.
const plain = (v: unknown): unknown =>
  v && typeof v === 'object' && 'value' in v && 'signature' in v ? (v as { value: unknown }).value : v;

/**
 * NetworkManager over D-Bus (Raspberry Pi OS Bookworm and later, most Linux desktops). The `rapthooker` user needs a
 * polkit rule for network-control, wifi.scan and settings.modify.system (deploy/pi/setup.d/50-screens.sh).
 *
 * A hotspot is joined with a "volatile" connection: NetworkManager forgets it as soon as it's not in use, and it never
 * starts by itself, so the hub's saved networks are never touched.
 */
export class NetworkManagerWifi implements WifiController {
  readonly name = 'networkmanager';
  private dbus: Dbus | null = null;
  private bus: MessageBus | null = null;
  /** The connection to go back to, from the first join; undefined when no set-up is going on. */
  private previous: { device: string; connection: string | null } | undefined;

  constructor(
    private readonly log: Logger,
    private readonly opts: { dbus?: Dbus } = {},
  ) {}

  private async connect(): Promise<MessageBus> {
    if (this.bus) return this.bus;
    this.dbus = this.opts.dbus ?? (await import('dbus-next'));
    this.bus = this.dbus.systemBus();
    this.bus.on('error', (err: Error) => {
      this.log.warn({ err: err.message }, 'D-Bus connection to NetworkManager failed');
      this.bus = null;
    });
    return this.bus;
  }

  private async call(path: string, iface: string, member: string, signature?: string, body?: unknown[]): Promise<unknown[]> {
    const bus = await this.connect();
    const { Message } = this.dbus!;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`NetworkManager ${member} timed out`)), CALL_TIMEOUT_MS);
    });
    try {
      const reply = await Promise.race([
        bus.call(new Message({ destination: NM, path, interface: iface, member, signature, body })),
        timeout,
      ]);
      return (reply?.body ?? []) as unknown[];
    } finally {
      clearTimeout(timer);
    }
  }

  private async prop<T>(path: string, iface: string, name: string): Promise<T> {
    const [v] = await this.call(path, PROPS, 'Get', 'ss', [iface, name]);
    return plain(v) as T;
  }

  private v(signature: string, value: unknown): unknown {
    return new this.dbus!.Variant(signature, value);
  }

  /** The first Wi-Fi device, or null. */
  private async wifiDevice(): Promise<{ path: string; iface: string } | null> {
    const [devices] = (await this.call(NM_PATH, NM, 'GetDevices')) as [string[]];
    for (const path of devices ?? []) {
      if ((await this.prop<number>(path, DEVICE, 'DeviceType')) === DEVICE_WIFI) {
        return { path, iface: await this.prop<string>(path, DEVICE, 'Interface') };
      }
    }
    return null;
  }

  private async permissions(): Promise<Record<string, string>> {
    const [perms] = (await this.call(NM_PATH, NM, 'GetPermissions')) as [Record<string, string>];
    return perms ?? {};
  }

  async status(): Promise<WifiStatus> {
    const off = (reason: string): WifiStatus => ({
      canSetUp: false,
      reason,
      ssid: null,
      channel: null,
      goesOffline: false,
      knowsPassword: false,
    });
    let device: { path: string; iface: string } | null;
    try {
      device = await this.wifiDevice();
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'NetworkManager not available');
      return off('no-networkmanager');
    }
    if (!device) return off('no-adapter');
    const perms = await this.permissions().catch(() => ({}) as Record<string, string>);
    const allowed = [`${NM}.network-control`, `${NM}.settings.modify.system`].every((p) => perms[p] === 'yes');
    let ssid: string | null = null;
    let channel: number | null = null;
    const ap = await this.prop<string>(device.path, WIRELESS, 'ActiveAccessPoint').catch(() => '/');
    if (ap && ap !== '/') {
      ssid = Buffer.from(await this.prop<Buffer>(ap, `${NM}.AccessPoint`, 'Ssid')).toString('utf8');
      channel = channelOf(await this.prop<number>(ap, `${NM}.AccessPoint`, 'Frequency'));
    }
    const knowsPassword = ssid !== null && allowed && (await this.password(ssid).catch(() => null)) !== null;
    return {
      canSetUp: allowed,
      reason: allowed ? null : 'not-allowed',
      ssid,
      channel,
      goesOffline: ssid !== null && !(await this.otherLink(device.iface)),
      knowsPassword,
    };
  }

  /** Whether the hub has a way onto the network besides its Wi-Fi (Ethernet, say). */
  private async otherLink(wifiIface: string): Promise<boolean> {
    for (const [name, list] of Object.entries(networkInterfaces())) {
      if (name === wifiIface || /^(lo|docker|veth|br-|virbr|tailscale|tun|wg|zt)/i.test(name)) continue;
      if (list?.some((a) => !a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.'))) return true;
    }
    return false;
  }

  async scan(): Promise<WifiNetwork[]> {
    const device = await this.wifiDevice();
    if (!device) return [];
    try {
      await this.call(device.path, WIRELESS, 'RequestScan', 'a{sv}', [{}]);
      await sleep(4000);
    } catch (err) {
      // NetworkManager refuses a scan right after another; the last results will do.
      this.log.debug({ err: (err as Error).message }, 'Wi-Fi scan not started');
    }
    const active = await this.prop<string>(device.path, WIRELESS, 'ActiveAccessPoint').catch(() => '/');
    const [aps] = (await this.call(device.path, WIRELESS, 'GetAllAccessPoints')) as [string[]];
    const out: WifiNetwork[] = [];
    for (const ap of aps ?? []) {
      try {
        const [all] = (await this.call(ap, PROPS, 'GetAll', 's', [`${NM}.AccessPoint`])) as [Record<string, unknown>];
        const ssid = Buffer.from(plain(all.Ssid) as Buffer).toString('utf8');
        const freq = plain(all.Frequency) as number;
        const secure = (plain(all.Flags) as number) !== 0 || (plain(all.WpaFlags) as number) !== 0 || (plain(all.RsnFlags) as number) !== 0;
        out.push({
          ssid,
          bssid: String(plain(all.HwAddress)),
          signal: plain(all.Strength) as number,
          channel: channelOf(freq),
          band: bandOf(freq),
          secure,
          kind: hotspotKind(ssid),
          current: ap === active,
        });
      } catch {}
    }
    return tidyNetworks(out);
  }

  async join(ssid: string, timeoutMs: number): Promise<HotspotLink> {
    const device = await this.wifiDevice();
    if (!device) throw new Error('No Wi-Fi adapter');
    if (this.previous === undefined) {
      const active = await this.prop<string>(device.path, DEVICE, 'ActiveConnection').catch(() => '/');
      const connection = active && active !== '/' ? await this.prop<string>(active, ACTIVE, 'Connection').catch(() => null) : null;
      this.previous = { device: device.path, connection };
      this.log.info({ previous: connection }, 'leaving the Wi-Fi network for a screen');
    }
    await this.removeTemporary();
    const settings = {
      connection: {
        id: this.v('s', TEMP_ID),
        uuid: this.v('s', randomUUID()),
        type: this.v('s', '802-11-wireless'),
        autoconnect: this.v('b', false),
      },
      '802-11-wireless': { ssid: this.v('ay', Buffer.from(ssid, 'utf8')), mode: this.v('s', 'infrastructure') },
      // Never the hub's way to the internet, even for a moment.
      ipv4: { method: this.v('s', 'auto'), 'never-default': this.v('b', true) },
      ipv6: { method: this.v('s', 'ignore') },
    };
    const [, active] = (await this.call(NM_PATH, NM, 'AddAndActivate2', 'a{sa{sv}}ooa{sv}', [
      settings,
      device.path,
      '/',
      { persist: this.v('s', 'volatile') },
    ])) as [string, string];
    const address = await this.waitActive(active, timeoutMs);
    return { address, screen: SCREEN_ADDRESS };
  }

  /** Waits for a connection to come up and returns the hub's IPv4 address on it. */
  private async waitActive(active: string, timeoutMs: number): Promise<string> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      let state: number;
      try {
        state = await this.prop<number>(active, ACTIVE, 'State');
      } catch {
        throw new Error('The connection went away');
      }
      if (state === DEACTIVATED) throw new Error("Couldn't join the network");
      if (state === ACTIVATED) {
        const ip4 = await this.prop<string>(active, ACTIVE, 'Ip4Config');
        if (ip4 && ip4 !== '/') {
          const data = await this.prop<Record<string, unknown>[]>(ip4, `${NM}.IP4Config`, 'AddressData');
          const address = data?.[0] ? String(plain(data[0].address)) : null;
          if (address) return address;
        }
      }
      await sleep(500);
    }
    throw new Error('Timed out joining the network');
  }

  async restore(): Promise<boolean> {
    const previous = this.previous;
    if (previous === undefined) return true;
    let ok = false;
    try {
      if (previous.connection) {
        const [active] = (await this.call(NM_PATH, NM, 'ActivateConnection', 'ooo', [previous.connection, previous.device, '/'])) as [
          string,
        ];
        await this.waitActive(active, 60_000);
      } else {
        await this.call(previous.device, DEVICE, 'Disconnect').catch(() => undefined);
      }
      ok = true;
      this.log.info('back on the Wi-Fi network');
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "couldn't get back on the Wi-Fi network; leaving it to NetworkManager");
    } finally {
      this.previous = undefined;
      await this.removeTemporary().catch(() => undefined);
    }
    return ok;
  }

  private async connections(): Promise<{ path: string; settings: Record<string, Record<string, unknown>> }[]> {
    const [paths] = (await this.call(SETTINGS_PATH, `${NM}.Settings`, 'ListConnections')) as [string[]];
    const out: { path: string; settings: Record<string, Record<string, unknown>> }[] = [];
    for (const path of paths ?? []) {
      try {
        const [settings] = (await this.call(path, CONNECTION, 'GetSettings')) as [Record<string, Record<string, unknown>>];
        out.push({ path, settings });
      } catch {}
    }
    return out;
  }

  /** Deletes temporary connections (deleting an active one takes the hub off it; NetworkManager then reconnects). */
  private async removeTemporary(): Promise<void> {
    for (const c of await this.connections()) {
      if (String(plain(c.settings.connection?.id) ?? '').startsWith(TEMP_ID)) {
        await this.call(c.path, CONNECTION, 'Delete').catch(() => undefined);
      }
    }
  }

  async password(ssid: string): Promise<string | null> {
    for (const c of await this.connections()) {
      const raw = plain(c.settings['802-11-wireless']?.ssid);
      if (!raw || Buffer.from(raw as Buffer).toString('utf8') !== ssid) continue;
      try {
        const [secrets] = (await this.call(c.path, CONNECTION, 'GetSecrets', 's', ['802-11-wireless-security'])) as [
          Record<string, Record<string, unknown>>,
        ];
        const psk = plain(secrets?.['802-11-wireless-security']?.psk);
        if (typeof psk === 'string' && psk) return psk;
      } catch (err) {
        this.log.debug({ err: (err as Error).message }, "can't read the saved Wi-Fi password");
      }
    }
    return null;
  }

  async recover(): Promise<void> {
    try {
      await this.removeTemporary();
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'NetworkManager not available to tidy up');
    }
  }
}
