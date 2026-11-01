import { describe, expect, it } from 'vitest';
import { DEFAULT_HUB_SETTINGS, type BleStatus, type Pill } from '@rapthooker/shared';
import { LIVE_CACHE_MAX_AGE_MS, parseLive, serializeLive, type LiveSnapshot } from './liveCache';

const NOW = Date.UTC(2026, 9, 1, 12);

function pill(id: string, order = 0): Pill {
  return {
    id,
    kind: 'pill',
    address: 'AA:BB:CC:00:00:01',
    raptId: 'AA:BB:CC:00:00:03',
    name: `Pill ${id}`,
    color: '#a78bfa',
    createdAt: NOW - 86_400_000,
    archived: false,
    offsets: { gravity: 0, temperature: 0 },
    model: { gravitySource: 'pill', tiltPoints: [], tiltPoly: null, velocitySource: 'pill', velocityHours: 24, smoothing: 'off' },
    order,
    info: { firmware: null, deviceType: null, payloadVersion: null },
    live: {
      lastHeardAt: NOW - 60_000,
      lastReadingAt: NOW - 60_000,
      firstReadingAt: NOW - 86_400_000,
      online: true,
      rssi: -70,
      intervalSec: 300,
      latest: null,
      computedVelocity: null,
      caught: null,
    },
    brew: null,
  };
}

const ble: BleStatus = {
  state: 'scanning',
  adapter: 'hci0',
  adapters: ['hci0'],
  mode: 'passive',
  error: null,
  lastAdvertAt: NOW,
  since: NOW,
  relays: [],
};

const snapshot: LiveSnapshot = {
  pills: [pill('a', 0), pill('b', 1)],
  nearby: [],
  ble,
  clockSynced: true,
  hub: { ...DEFAULT_HUB_SETTINGS, name: 'Garage hub', units: { gravity: 'plato', temperature: 'F' } },
  screens: [
    {
      id: '025248000001',
      name: 'Kitchen',
      model: 'sdpro-240',
      mac: '02:52:48:00:00:01',
      hostname: 'rh-screen-000001',
      ip: '192.168.1.50',
      pillId: 'a',
      look: {
        theme: 'dark',
        palette: 'violet',
        show: ['gravity', 'temperature'],
        range: 'brew',
        gravity: 'sg',
        temperature: 'C',
        lang: 'en',
        tz: null,
        brewing: false,
      },
      interval: 60,
      brightness: 80,
      firmware: '1.0.3',
      createdAt: NOW - 86_400_000,
      status: {
        state: 'online',
        lastSeenAt: NOW - 20_000,
        rssi: -58,
        uptime: 3600,
        failures: 0,
        update: null,
        updating: false,
        error: null,
      },
    },
  ],
};

describe('live cache', () => {
  it('round-trips the live state with the time it was saved', () => {
    const back = parseLive(serializeLive(snapshot, NOW - 5000), NOW);
    expect(back).toEqual({ ...snapshot, savedAt: NOW - 5000 });
  });

  it('ignores nothing, junk, other versions and broken pills', () => {
    expect(parseLive(null, NOW)).toBeNull();
    expect(parseLive('not json', NOW)).toBeNull();
    expect(parseLive(JSON.stringify({ v: 99, savedAt: NOW, pills: [] }), NOW)).toBeNull();
    expect(parseLive(JSON.stringify({ v: 1, savedAt: NOW, pills: [{ id: 'x' }] }), NOW)).toBeNull();
    expect(parseLive(JSON.stringify([1, 2]), NOW)).toBeNull();
  });

  it('drops a cache that is too old to be useful', () => {
    expect(parseLive(serializeLive(snapshot, NOW - LIVE_CACHE_MAX_AGE_MS - 1), NOW)).toBeNull();
    expect(parseLive(serializeLive(snapshot, NOW - LIVE_CACHE_MAX_AGE_MS + 1000), NOW)).not.toBeNull();
  });

  it('fills in hub settings that are missing or odd with the defaults', () => {
    const raw = JSON.stringify({
      v: 1,
      savedAt: NOW,
      pills: [],
      nearby: 'nope',
      ble: null,
      hub: { name: '  ', units: { gravity: 'brix' } },
    });
    const back = parseLive(raw, NOW);
    expect(back?.hub).toEqual(DEFAULT_HUB_SETTINGS);
    expect(back?.nearby).toEqual([]);
    expect(back?.ble).toBeNull();
    expect(back?.clockSynced).toBe(true);
    // Saved before screens.
    expect(back?.screens).toEqual([]);
  });
});
