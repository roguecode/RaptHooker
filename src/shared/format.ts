import type { AlertKind } from './types.js';

/** Colours a pill can be given; the first unused one is picked when a pill is added. */
export const PILL_COLORS = ['#a78bfa', '#60a5fa', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#818cf8'];

export const normalizeAddress = (address: string): string => address.trim().toUpperCase();

/**
 * Whether a gravity looks like a real reading. Out of liquid (e.g. lying on a table) a pill still reports a gravity
 * worked out from its tilt, which can be far outside anything a beer could be.
 */
export const plausibleGravity = (sg: number): boolean => sg >= 0.98 && sg <= 1.2;

/** Stable pill id from its Bluetooth address. */
export const pillIdFromAddress = (address: string): string =>
  normalizeAddress(address)
    .replace(/[^0-9A-F]/g, '')
    .toLowerCase();

/**
 * The MAC address the RAPT app shows: the Bluetooth address with 2 taken off the last octet
 * (from KegLand's "Pill Hydrometer Bluetooth Transmissions" notes).
 */
export function raptIdFromAddress(address: string): string {
  const parts = normalizeAddress(address).split(':');
  if (parts.length !== 6) return normalizeAddress(address);
  const last = (parseInt(parts[5]!, 16) - 2 + 256) % 256;
  parts[5] = last.toString(16).toUpperCase().padStart(2, '0');
  return parts.join(':');
}

export interface AlertKindInfo {
  kind: AlertKind;
  label: string;
  /** What the threshold measures. */
  measure: 'temperature' | 'gravity' | 'points' | 'percent' | 'minutes';
  defaultThreshold: number;
  describe: string;
}

export const ALERT_KINDS: AlertKindInfo[] = [
  { kind: 'temp_above', label: 'Temperature above', measure: 'temperature', defaultThreshold: 24, describe: 'The beer gets too warm' },
  { kind: 'temp_below', label: 'Temperature below', measure: 'temperature', defaultThreshold: 16, describe: 'The beer gets too cold' },
  { kind: 'gravity_below', label: 'Gravity reaches', measure: 'gravity', defaultThreshold: 1.012, describe: 'Gravity drops to a target' },
  {
    kind: 'gravity_stable',
    label: 'Fermentation stable',
    measure: 'points',
    defaultThreshold: 1,
    describe: 'Gravity has changed less than this many points over the window',
  },
  { kind: 'battery_below', label: 'Battery below', measure: 'percent', defaultThreshold: 20, describe: 'The pill needs charging' },
  {
    kind: 'offline',
    label: 'Pill goes quiet',
    measure: 'minutes',
    defaultThreshold: 60,
    describe: 'Nothing heard from the pill for a while',
  },
];

export const alertKindInfo = (kind: AlertKind): AlertKindInfo => ALERT_KINDS.find((k) => k.kind === kind) ?? ALERT_KINDS[0]!;
