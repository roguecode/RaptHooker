import { DEFAULT_HUB_SETTINGS, type BleStatus, type HubSettings, type NearbyPill, type Pill } from '@rapthooker/shared';

/** The last live state, kept in this browser so the app can show something when the hub can't be reached. */
export interface LiveSnapshot {
  pills: Pill[];
  nearby: NearbyPill[];
  ble: BleStatus | null;
  clockSynced: boolean;
  hub: HubSettings;
}

export interface CachedLive extends LiveSnapshot {
  savedAt: number;
}

export const LIVE_CACHE_KEY = 'rapthooker.live-cache';
const VERSION = 1;
/** Older than this, saved readings are more confusing than useful. */
export const LIVE_CACHE_MAX_AGE_MS = 60 * 86_400_000;

export function serializeLive(s: LiveSnapshot, savedAt: number): string {
  return JSON.stringify({ v: VERSION, savedAt, pills: s.pills, nearby: s.nearby, ble: s.ble, clockSynced: s.clockSynced, hub: s.hub });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isPill(v: unknown): v is Pill {
  return isObject(v) && typeof v.id === 'string' && typeof v.name === 'string' && isObject(v.live) && typeof v.order === 'number';
}

function isNearby(v: unknown): v is NearbyPill {
  return isObject(v) && typeof v.address === 'string' && typeof v.lastHeardAt === 'number';
}

function hubFrom(v: unknown): HubSettings {
  if (!isObject(v)) return DEFAULT_HUB_SETTINGS;
  const units = isObject(v.units) ? v.units : {};
  return {
    name: typeof v.name === 'string' && v.name.trim() ? v.name : DEFAULT_HUB_SETTINGS.name,
    units: {
      gravity: units.gravity === 'plato' ? 'plato' : 'sg',
      temperature: units.temperature === 'F' ? 'F' : 'C',
    },
    abvFormula: v.abvFormula === 'alternative' ? 'alternative' : 'standard',
    updateCheck: v.updateCheck !== false,
  };
}

/** The saved state, or null when there's none, it's from another version, broken, or too old. */
export function parseLive(raw: string | null, now: number): CachedLive | null {
  if (!raw) return null;
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(d) || d.v !== VERSION || typeof d.savedAt !== 'number' || !Array.isArray(d.pills)) return null;
  if (now - d.savedAt > LIVE_CACHE_MAX_AGE_MS) return null;
  if (!d.pills.every(isPill)) return null;
  return {
    savedAt: d.savedAt,
    // Saved before thermometers were supported, everything was a pill.
    pills: d.pills.map((p) => ({ ...p, kind: p.kind === 'thermometer' ? 'thermometer' : 'pill' })),
    nearby: Array.isArray(d.nearby)
      ? d.nearby.filter(isNearby).map((n) => ({ ...n, kind: n.kind === 'thermometer' ? 'thermometer' : 'pill' }))
      : [],
    ble: isObject(d.ble) && typeof d.ble.state === 'string' ? (d.ble as unknown as BleStatus) : null,
    clockSynced: d.clockSynced !== false,
    hub: hubFrom(d.hub),
  };
}

export function loadLiveCache(now = Date.now()): CachedLive | null {
  try {
    return parseLive(window.localStorage.getItem(LIVE_CACHE_KEY), now);
  } catch {
    return null;
  }
}

export function saveLiveCache(s: LiveSnapshot, now = Date.now()): void {
  try {
    window.localStorage.setItem(LIVE_CACHE_KEY, serializeLive(s, now));
  } catch (err) {
    // Full storage: better no cache than a stale one.
    console.warn('live cache', err);
    try {
      window.localStorage.removeItem(LIVE_CACHE_KEY);
    } catch {}
  }
}
