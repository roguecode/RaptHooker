import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { CompositeScanner } from '../ble/composite.js';
import { RelayHub } from '../ble/relays.js';
import { UnavailableScanner } from '../ble/scanner.js';
import { decodeRapt, KEG_COMPANY_ID, RAPT_COMPANY_ID } from '../ble/rapt.js';
import { CAPTURED, silent, tempStore } from './helpers.js';

interface BurstFixture {
  pill: string;
  intervalMs: number;
  /** When each transmission started, after k × intervalMs. */
  firstTransmissionDelaysMs: number[];
  /** readings[0] was sent before the capture began; readings[k + 1] is transmission k's new reading. */
  readings: string[];
  events: { t: number; source: string; address: string; rssi: number | null; manufacturerData: Record<string, string> }[];
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/rapt-bursts.json', import.meta.url), 'utf8')) as BurstFixture;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
});

/** Plays the captured adverts through the scanner (radio and relay) into PillService, in step with a fake clock. */
function replay() {
  vi.useFakeTimers();
  const t = tempStore();
  cleanup = t.cleanup;
  const start = Date.UTC(2026, 9, 1, 12);
  let now = start;
  const clock = new ClockGuard({ syncFile: null, maxWaitMs: 0, now: () => now, mono: () => now });
  const pills = new PillService(t.store, clock, silent, () => now, { holdMs: 2500 });
  pills.load();
  const radio = new UnavailableScanner('replay');
  const relays = new RelayHub(silent, () => now);
  const scanner = new CompositeScanner(radio, relays);
  scanner.on('advert', (a) => pills.handleAdvert(a));
  const { id } = pills.adopt(fixture.pill, { name: 'Replay' });

  let at = 0;
  const step = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };
  for (const e of fixture.events) {
    step(e.t - at);
    at = e.t;
    if (e.source.startsWith('relay:')) {
      relays.ingest(e.source.slice('relay:'.length), [{ address: e.address, rssi: e.rssi, manufacturerData: e.manufacturerData }]);
      continue;
    }
    const entries = Object.entries(e.manufacturerData).map(([k, hex]) => [Number(k), Buffer.from(hex, 'hex')] as const);
    radio.emit('advert', {
      address: e.address,
      rssi: e.rssi,
      manufacturer: entries.length ? new Map(entries) : null,
      at: now,
      mono: now,
      cached: false,
      source: e.source,
    });
  }
  step(10_000);
  return { store: t.store, pills, relays, id, start };
}

/** When transmission k began, relative to the start of the capture. */
const sentAt = (k: number) => k * fixture.intervalMs + fixture.firstTransmissionDelaysMs[k]!;

describe('replaying captured bursts', () => {
  it('stores each reading once, at the time it was first heard', () => {
    const { store, id, start } = replay();
    const rows = store.latestReadings(id, 100).reverse();
    // The reading re-sent before the first new one, then one per transmission, including the two the hub missed.
    expect(rows).toHaveLength(fixture.readings.length);
    const sgs = fixture.readings.map((hex) => {
      const d = decodeRapt(RAPT_COMPANY_ID, Buffer.from(hex, 'hex'));
      return d?.kind === 'metrics' ? d.metrics.sg : NaN;
    });
    expect(rows.map((r) => r.sg)).toEqual(sgs);

    const ts = rows.map((r) => r.ts - start);
    // Heard first in transmission 0, as it was re-sent.
    expect(ts[0]).toBe(0);
    for (let k = 0; k < 12; k++) {
      const stored = ts[k + 1]!;
      if (k === 6 || k === 9) {
        // Missed (6 entirely, 9's new reading), recovered from the re-send in the next transmission and back-dated by
        // the learned interval: within a second of when it was really sent.
        expect(Math.abs(stored - (sentAt(k) + 900))).toBeLessThan(1000);
      } else {
        // The new reading's first advert comes 900 ms into the burst.
        expect(stored).toBe(sentAt(k) + 900);
      }
    }
  });

  it('learns the interval, counts every reading as caught and reads the firmware adverts', () => {
    const { pills, id } = replay();
    const pill = pills.get(id)!;
    expect(pills.intervalSec(id)).toBe(124);
    expect(pill.live.caught).toMatchObject({ received: fixture.readings.length, expected: fixture.readings.length });
    const firmware = decodeRapt(KEG_COMPANY_ID, Buffer.from(CAPTURED.firmware, 'hex'));
    expect(pill.info.firmware).toBe(firmware?.kind === 'firmware' ? firmware.firmware : null);
    expect(pill.info.deviceType).toBe('PillG1');
    expect(pill.info.payloadVersion).toBe(2);
    // The last advert from the pill came through hci0 at -74 dBm.
    expect(pill.live.rssi).toBe(-74);
  });

  it("ignores other devices' adverts, including non-RAPT data under RAPT's company id", () => {
    const { pills } = replay();
    expect(pills.nearby()).toEqual([]);
  });

  it('counts the relay that heard the pill too, without storing its copies twice', () => {
    const { relays, store, id } = replay();
    expect(relays.list()).toEqual([expect.objectContaining({ name: 'shed', adverts: 2 })]);
    expect(store.countReadings(id)).toBe(fixture.readings.length);
  });
});
