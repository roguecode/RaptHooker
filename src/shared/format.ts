import type { AlertKind } from './types.js';

/** Colours a pill can be given; the first unused one is picked when a pill is added. */
export const PILL_COLORS = ['#a78bfa', '#60a5fa', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#818cf8'];

export const normalizeAddress = (address: string): string => address.trim().toUpperCase();

/**
 * Whether a gravity looks like a real reading. Out of liquid (e.g. lying on a table) a pill still reports a gravity
 * worked out from its tilt, which can be far outside anything a beer could be.
 */
export const plausibleGravity = (sg: number): boolean => sg >= 0.98 && sg <= 1.2;

/**
 * Stable device id from its address: a Bluetooth address's hex digits, or "ispindel-<chip id>" for an iSpindel. How
 * an existing kind's id is worked out must never change (readings, brews and Home Assistant use it).
 */
export const pillIdFromAddress = (address: string): string => {
  const a = normalizeAddress(address);
  if (a.startsWith('ISPINDEL:'))
    return `ispindel-${a
      .slice('ISPINDEL:'.length)
      .replace(/[^0-9A-F]/g, '')
      .toLowerCase()}`;
  return a.replace(/[^0-9A-F]/g, '').toLowerCase();
};

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
  /** What the threshold measures ('velocity': points per day the gravity is dropping; 'drop': points it has dropped). */
  measure: 'temperature' | 'gravity' | 'points' | 'drop' | 'velocity' | 'percent' | 'days' | 'minutes';
  defaultThreshold: number;
  describe: string;
}

/**
 * Steps in a brew: they only watch a running brew (whatever "only while a brew is running" says), go off once in it
 * and don't clear, so there's no "back to normal".
 */
export const ONCE_PER_BREW: ReadonlySet<AlertKind> = new Set<AlertKind>(['fermentation_started', 'attenuation_reached', 'brew_day']);

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
  {
    kind: 'velocity_slow',
    label: 'Fermentation slows',
    measure: 'velocity',
    // About when most brewers dry hop: 2–3 points above the final gravity, where a typical ale drops about 3 a day.
    defaultThreshold: 3,
    describe: 'Gravity drops fewer points a day than this',
  },
  {
    kind: 'velocity_fast',
    label: 'Fermentation speeds up',
    measure: 'velocity',
    defaultThreshold: 10,
    describe: 'Gravity drops more points a day than this',
  },
  {
    kind: 'fermentation_started',
    label: 'Fermentation starts',
    measure: 'drop',
    // Clear of a pill's drift and of how it reads while it settles in.
    defaultThreshold: 3,
    describe: 'Once a brew, when its gravity has dropped this many points',
  },
  {
    kind: 'attenuation_reached',
    label: 'Attenuation reaches',
    measure: 'percent',
    // About when a dry hop goes in for biotransformation.
    defaultThreshold: 50,
    describe: 'Once a brew, when it has fermented this much of its sugar',
  },
  {
    kind: 'brew_day',
    label: 'Days into the brew',
    measure: 'days',
    defaultThreshold: 3,
    describe: 'Once a brew, a reminder this many days after it started',
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

/**
 * Where a velocity alert clears, in points a day dropped: a point a day back past its threshold, or half the threshold
 * if that's less (so one at 0.5 clears at 0.75, not 1.5).
 */
export function velocityClearsAt(kind: 'velocity_slow' | 'velocity_fast', threshold: number): number {
  const band = Math.min(1, Math.abs(threshold) / 2);
  return kind === 'velocity_slow' ? threshold + band : threshold - band;
}

/** Where "Fermentation stable" clears: once the gravity has moved a point more than its threshold over the window. */
export const stableClearsAt = (threshold: number): number => threshold + 1;
