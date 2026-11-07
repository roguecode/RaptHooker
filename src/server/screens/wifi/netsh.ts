import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hotspotKind, type WifiNetwork, type WifiStatus } from '@rapthooker/shared';
import type { Logger } from '../../log.js';
import { tidyNetworks, type HotspotLink, type WifiController } from './types.js';

const SCREEN_ADDRESS = '192.168.4.1';
const PROFILE_PREFIX = 'rapthooker-';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function netsh(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('netsh', ['wlan', ...args], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }, (err, out) =>
      err && !out ? reject(err) : resolve(out),
    ),
  );
}

/** "Name : value" lines of netsh's output (English Windows). */
function field(text: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, 'mi').exec(text);
  return m ? m[1]!.trim() : null;
}

/** Parses `netsh wlan show networks mode=bssid`. */
export function parseNetworks(text: string, current: string | null): WifiNetwork[] {
  const out: WifiNetwork[] = [];
  for (const block of text.split(/^SSID \d+ :/m).slice(1)) {
    const ssid = block.split(/\r?\n/)[0]!.trim();
    const secure = !/^\s*Authentication\s*:\s*Open/im.test(block);
    for (const ap of block.split(/^\s*BSSID \d+\s*:/m).slice(1)) {
      const bssid = ap.split(/\r?\n/)[0]!.trim();
      const signal = Number(/Signal\s*:\s*(\d+)%/i.exec(ap)?.[1] ?? 0);
      const channel = Number(/Channel\s*:\s*(\d+)/i.exec(ap)?.[1] ?? 0);
      const bandText = /Band\s*:\s*([\d.]+)\s*GHz/i.exec(ap)?.[1];
      const band = bandText ? Number(bandText) : channel > 14 ? 5 : 2.4;
      out.push({ ssid, bssid, signal, channel, band, secure, kind: hotspotKind(ssid), current: ssid === current });
    }
  }
  return tidyNetworks(out);
}

/**
 * Windows' netsh: so the development server on a PC with a USB Wi-Fi adapter can set up a real screen. Hotspots are
 * joined with a profile of their own (removed again afterwards); the PC's own Wi-Fi profiles aren't touched.
 */
export class NetshWifi implements WifiController {
  readonly name = 'netsh';
  private previous: { profile: string | null } | undefined;
  private readonly made = new Set<string>();

  constructor(private readonly log: Logger) {}

  private async iface(): Promise<{ name: string; text: string } | null> {
    const text = await netsh('show', 'interfaces');
    const name = field(text, 'Name');
    return name ? { name, text } : null;
  }

  async status(): Promise<WifiStatus> {
    const i = await this.iface().catch(() => null);
    if (!i)
      return { canSetUp: false, reason: 'no-adapter', ssid: null, channel: null, band: null, goesOffline: false, knowsPassword: false };
    const connected = /^\s*State\s*:\s*connected/im.test(i.text);
    const ssid = connected ? field(i.text, 'SSID') : null;
    const channel = connected ? Number(field(i.text, 'Channel') ?? 0) || null : null;
    const band = channel === null ? null : Number.parseFloat(field(i.text, 'Band') ?? '') || (channel > 14 ? 5 : 2.4);
    return {
      canSetUp: true,
      reason: null,
      ssid,
      channel,
      band,
      goesOffline: ssid !== null && !this.otherLink(i.name),
      knowsPassword: false,
    };
  }

  private otherLink(wifi: string): boolean {
    return Object.entries(networkInterfaces()).some(
      ([name, list]) =>
        name !== wifi &&
        !/loopback|vEthernet|VirtualBox|VMware|Tailscale|NordLynx/i.test(name) &&
        (list ?? []).some((a) => !a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.')),
    );
  }

  async scan(): Promise<WifiNetwork[]> {
    const status = await this.status();
    return parseNetworks(await netsh('show', 'networks', 'mode=bssid'), status.ssid);
  }

  async join(ssid: string, timeoutMs: number): Promise<HotspotLink> {
    const i = await this.iface();
    if (!i) throw new Error('No Wi-Fi adapter');
    if (this.previous === undefined) {
      const connected = /^\s*State\s*:\s*connected/im.test(i.text);
      this.previous = { profile: connected ? field(i.text, 'Profile') : null };
    }
    const profile = `${PROFILE_PREFIX}${ssid}`;
    const dir = mkdtempSync(join(tmpdir(), 'rh-wifi-'));
    try {
      const file = join(dir, 'profile.xml');
      writeFileSync(
        file,
        `<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${xml(profile)}</name>` +
          `<SSIDConfig><SSID><name>${xml(ssid)}</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode>` +
          '<MSM><security><authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX>' +
          '</authEncryption></security></MSM></WLANProfile>',
      );
      await netsh('add', 'profile', `filename=${file}`, `interface=${i.name}`, 'user=current');
      this.made.add(profile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const until = Date.now() + timeoutMs;
    let asked = 0;
    while (Date.now() < until) {
      if (Date.now() - asked > 8000) {
        asked = Date.now();
        await netsh('connect', `name=${profile}`, `ssid=${ssid}`, `interface=${i.name}`).catch(() => undefined);
      }
      await sleep(1000);
      const now = await this.iface().catch(() => null);
      if (!now || field(now.text, 'SSID') !== ssid || !/^\s*State\s*:\s*connected/im.test(now.text)) continue;
      const address = (networkInterfaces()[i.name] ?? []).find((a) => a.family === 'IPv4' && !a.address.startsWith('169.254.'))?.address;
      if (address) return { address, screen: SCREEN_ADDRESS };
    }
    throw new Error(`Timed out joining ${ssid}`);
  }

  async restore(): Promise<boolean> {
    const previous = this.previous;
    this.previous = undefined;
    const i = await this.iface().catch(() => null);
    try {
      if (i) {
        if (previous?.profile) await netsh('connect', `name=${previous.profile}`, `interface=${i.name}`);
        else await netsh('disconnect', `interface=${i.name}`);
      }
      return true;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "couldn't get back on the Wi-Fi network");
      return false;
    } finally {
      for (const p of this.made) await netsh('delete', 'profile', `name=${p}`).catch(() => undefined);
      this.made.clear();
    }
  }

  async password(): Promise<string | null> {
    return null;
  }

  async recover(): Promise<void> {
    const i = await this.iface().catch(() => null);
    const profile = i ? field(i.text, 'Profile') : null;
    if (i && profile?.startsWith(PROFILE_PREFIX)) await netsh('disconnect', `interface=${i.name}`).catch(() => undefined);
  }
}
