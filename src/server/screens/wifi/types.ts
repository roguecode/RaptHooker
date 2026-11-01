import type { WifiNetwork, WifiStatus } from '@rapthooker/shared';

/** Where the hub is on a screen's hotspot. */
export interface HotspotLink {
  /** The hub's own address on the hotspot, or null if it doesn't matter (tests). */
  address: string | null;
  /** Where the screen answers: 192.168.4.1 (both firmwares), or a fake screen's address in tests. */
  screen: string;
}

/**
 * Switches the hub's Wi-Fi to a screen's open hotspot and back. Joining is always temporary: nothing about the hub's
 * own saved networks changes, and `restore` (or `recover`, after a crash) puts back the network it was on.
 */
export interface WifiController {
  readonly name: string;
  status(): Promise<WifiStatus>;
  /** Networks the hub can see, strongest first. */
  scan(): Promise<WifiNetwork[]>;
  /** Joins an open network for now. The first join remembers the network to go back to. */
  join(ssid: string, timeoutMs: number): Promise<HotspotLink>;
  /** Back on the network from before the first join. True once the hub has it again (or wasn't on one). */
  restore(): Promise<boolean>;
  /** The password the hub has saved for a network, if it can read it. */
  password(ssid: string): Promise<string | null>;
  /** After a crash or restart in the middle of a set-up: leaves any hotspot and tidies up. */
  recover(): Promise<void>;
}

/** Why a hub can't set screens up itself (WifiStatus.reason). */
export type WifiUnavailableReason = 'off' | 'unsupported-os' | 'no-networkmanager' | 'no-adapter' | 'not-allowed';

/** A hub that can't switch networks (Docker, macOS, or switched off in the config). */
export class NoWifi implements WifiController {
  readonly name = 'none';
  constructor(private readonly reason: WifiUnavailableReason) {}
  async status(): Promise<WifiStatus> {
    return { canSetUp: false, reason: this.reason, ssid: null, channel: null, goesOffline: false, knowsPassword: false };
  }
  async scan(): Promise<WifiNetwork[]> {
    return [];
  }
  async join(): Promise<HotspotLink> {
    throw new Error("This hub can't change Wi-Fi networks");
  }
  async restore(): Promise<boolean> {
    return true;
  }
  async password(): Promise<string | null> {
    return null;
  }
  async recover(): Promise<void> {}
}

/** 802.11 channel from a frequency in MHz. */
export function channelOf(mhz: number): number {
  if (mhz === 2484) return 14;
  if (mhz >= 2412 && mhz <= 2472) return (mhz - 2407) / 5;
  if (mhz >= 5000 && mhz < 5925) return (mhz - 5000) / 5;
  if (mhz >= 5925 && mhz <= 7125) return (mhz - 5950) / 5;
  return 0;
}

export const bandOf = (mhz: number): number => (mhz < 3000 ? 2.4 : mhz < 5925 ? 5 : 6);

/** Strongest first, one entry per network name and band (the strongest access point of a mesh). */
export function tidyNetworks(list: WifiNetwork[]): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const n of list) {
    if (!n.ssid) continue;
    const key = `${n.ssid}\u0000${n.band}`;
    const had = best.get(key);
    if (!had || n.signal > had.signal || (n.current && !had.current))
      best.set(key, { ...n, current: n.current || (had?.current ?? false) });
  }
  return [...best.values()].sort((a, b) => Number(b.kind !== null) - Number(a.kind !== null) || b.signal - a.signal);
}
