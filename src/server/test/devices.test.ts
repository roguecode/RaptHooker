import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_VESSEL, vesselFill, volumeScale } from '@rapthooker/shared';
import { ClockGuard } from '../clock.js';
import { PillService, THERMOMETER_SAMPLE_MS } from '../pills.js';
import { BrewError, BrewService } from '../brews.js';
import { KegService } from '../kegs.js';
import { APPLE_COMPANY_ID, RAPT_COMPANY_ID, decodeRapt, encodeRaptLaser, encodeRaptThermometer } from '../ble/rapt.js';
import { decodeTilt, encodeTilt, isTiltBeacon, tiltColorOf } from '../ble/tilt.js';
import { decodeAdvert } from '../ble/devices.js';
import { advertFromRelay } from '../ble/relays.js';
import type { Advert } from '../ble/scanner.js';
import { csvLines } from '../routes/csv.js';
import { MQTT_ENTITIES, hasEntity, statePayload } from '../mqtt.js';
import { CAPTURED, silent, tempStore } from './helpers.js';

const TILT = 'A4:C1:38:11:22:33';
const LASER = 'D8:3B:DA:44:55:66';
const DAY = 86_400_000;
const hex = (s: string) => Buffer.from(s, 'hex');

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const t = tempStore();
  cleanup = t.cleanup;
  let now = Date.UTC(2026, 10, 3, 12);
  const clock = new ClockGuard({ syncFile: null, maxWaitMs: 0, now: () => now, mono: () => now });
  const pills = new PillService(t.store, clock, silent, () => now);
  pills.load();
  const brews = new BrewService(t.store, pills, silent, () => now);
  pills.brewOf = (id) => brews.activeFor(id);
  const hear = (address: string, companyId: number, data: Buffer | null, extra: Partial<Advert> = {}) =>
    pills.handleAdvert({
      address,
      rssi: -60,
      manufacturer: data ? new Map([[companyId, data]]) : null,
      at: now,
      mono: now,
      cached: false,
      ...extra,
    });
  return { store: t.store, pills, brews, hear, advance: (ms: number) => (now += ms), now: () => now };
}

describe('Tilt adverts', () => {
  it("reads a Tilt's iBeacon: its colour, °F and SG, and a Tilt Pro's extra digit", () => {
    // Red, 68 °F, SG 1.050, as Tilt's own apps and Home Assistant's tilt-ble read it.
    const red = hex('0215a495bb10c5b14b44b5121370f02d74de0044041ac5');
    expect(tiltColorOf(red)).toBe('Red');
    expect(decodeTilt(APPLE_COMPANY_ID, red)).toMatchObject({ kind: 'tilt', metrics: { color: 'Red', pro: false, temp: 20, sg: 1.05 } });
    expect(encodeTilt({ color: 'Red', tempF: 68, sg: 1.05, power: -59 }).toString('hex')).toBe(red.toString('hex'));

    // A Tilt Pro: °F × 10 and SG × 10000 (68.5 °F, 1.0503).
    const pro = encodeTilt({ color: 'Pink', pro: true, tempF: 68.5, sg: 1.0503 });
    expect(decodeTilt(APPLE_COMPANY_ID, pro)).toMatchObject({ metrics: { color: 'Pink', pro: true, temp: 20.2778, sg: 1.0503 } });

    for (const color of ['Green', 'Black', 'Purple', 'Orange', 'Blue', 'Yellow'] as const)
      expect(decodeTilt(APPLE_COMPANY_ID, encodeTilt({ color, tempF: 60, sg: 1.01 }))?.metrics.color).toBe(color);
  });

  it("leaves out the beacon that isn't a reading, and anything that isn't a Tilt", () => {
    // Every now and then a Tilt sends 999 for the temperature.
    expect(decodeTilt(APPLE_COMPANY_ID, encodeTilt({ color: 'Red', tempF: 999, sg: 1.005 }))).toBeNull();
    // Someone else's iBeacon, and a Tilt's UUID under another company id.
    const other = hex('0215a495bb90c5b14b44b5121370f02d74de0044041ac5');
    expect(isTiltBeacon(other)).toBe(false);
    expect(decodeTilt(APPLE_COMPANY_ID, hex('0215f7826da64fa24e988024bc5b71e0893e0044041ac5'))).toBeNull();
    expect(decodeTilt(RAPT_COMPANY_ID, encodeTilt({ color: 'Red', tempF: 68, sg: 1.05 }))).toBeNull();
    // The RAPT Thermometer's iBeacon is still a thermometer's.
    expect(decodeAdvert(APPLE_COMPANY_ID, hex(CAPTURED.thermometerRest))).toEqual({ kind: 'thermometer', temp: 15.3 });
  });
});

describe('RAPT Laser Level adverts', () => {
  it('reads the layout YDraig and splitice found: distance, battery, temperature and firmware, little-endian', () => {
    // "PT" A1, its MAC, 300 mm, 260 mm remaining, firmware 1.0, 86.5 %, 4.25 °C, mode 1.
    const data = hex('5054a1d83bda445566' + '2c01' + '0401' + '0a' + '6103' + 'a901' + '01');
    expect(decodeRapt(RAPT_COMPANY_ID, data)).toEqual({
      kind: 'laser',
      laser: { distance: 300, temp: 4.25, battery: 86.5, firmware: '1.0' },
      fingerprint: '300|4.25|86.5',
    });
    expect(encodeRaptLaser({ mac: 'D8:3B:DA:44:55:66', distance: 300, battery: 86.5, temp: 4.25 }).toString('hex')).toBe(
      data.toString('hex'),
    );
    // Without its mode byte, and with no battery or temperature (FFFF, 8000).
    expect(decodeRapt(RAPT_COMPANY_ID, hex('5054a1d83bda445566' + '2c01' + '0401' + '17' + 'ffff' + '0080'))).toMatchObject({
      laser: { distance: 300, temp: null, battery: null, firmware: '2.3' },
    });
  });

  it("fits thewolf-oz's captures: bytes 9 and 11 add up to 48 or 304 as distance and remaining add up to 560 mm", () => {
    // Byte 12 is 2 with the beer near the lid, 1 further down; byte 13 is always 0A; battery 100 %.
    const near = hex('5054a1d83bda445566' + '14' + '00' + '1c' + '02' + '0a' + 'e803' + '9001' + '03');
    const far = hex('5054a1d83bda445566' + 'a3' + '00' + '8d' + '01' + '0a' + 'e803' + '9001' + '04');
    expect(near[9]! + near[11]!).toBe(48);
    expect(far[9]! + far[11]!).toBe(304);
    expect(decodeRapt(RAPT_COMPANY_ID, near)).toMatchObject({ laser: { distance: 20, battery: 100, temp: 4, firmware: '1.0' } });
    expect(decodeRapt(RAPT_COMPANY_ID, far)).toMatchObject({ laser: { distance: 163, battery: 100, temp: 4, firmware: '1.0' } });
    // Remaining (bytes 11–12) and the distance make up the 560 mm keg in both.
    expect(near.readUInt16LE(9) + near.readUInt16LE(11)).toBe(560);
    expect(far.readUInt16LE(9) + far.readUInt16LE(11)).toBe(560);
  });

  it("reads older firmware's shorter adverts, and one that only says what it is", () => {
    expect(decodeRapt(RAPT_COMPANY_ID, hex('5054a1' + '2c01' + 'd83bda445566' + '00' + '91'))).toMatchObject({
      laser: { distance: 300, temp: null, battery: null, firmware: '0.9.1' },
    });
    expect(decodeRapt(RAPT_COMPANY_ID, hex('5054a1'))).toMatchObject({ kind: 'laser', laser: { distance: null } });
    // 0 mm, or more than its 6 m, isn't a distance.
    expect(decodeRapt(RAPT_COMPANY_ID, encodeRaptLaser({ mac: 'D8:3B:DA:44:55:66', distance: 0, battery: 80, temp: 4 }))).toMatchObject({
      laser: { distance: null },
    });
  });

  it("decodes pills' adverts exactly as before", () => {
    for (const key of ['metricsFalling', 'metricsRising', 'metricsOutOfLiquid', 'deviceType'] as const) {
      const decoded = decodeRapt(RAPT_COMPANY_ID, hex(CAPTURED[key]));
      expect(decoded?.kind, key).not.toBe('laser');
      expect(decodeAdvert(RAPT_COMPANY_ID, hex(CAPTURED[key]))).toEqual(decoded);
    }
    expect(decodeRapt(RAPT_COMPANY_ID, hex(CAPTURED.metricsFalling))).toMatchObject({ kind: 'metrics', metrics: { version: 2 } });
  });
});

describe('a Tilt', () => {
  it('is listed nearby by its colour, and added with its name, colour and a velocity worked out by RaptHooker', () => {
    const t = setup();
    t.hear(TILT, APPLE_COMPANY_ID, encodeTilt({ color: 'Red', tempF: 68, sg: 1.05 }));
    expect(t.pills.nearby()).toEqual([
      expect.objectContaining({ address: TILT, kind: 'tilt', raptId: TILT, info: expect.objectContaining({ deviceType: 'Tilt Red' }) }),
    ]);
    expect(t.pills.nearby()[0]!.latest).toMatchObject({ gravity: 1.05, temperature: 20, battery: null, tilt: null, x: null });

    const pill = t.pills.adopt(TILT, {});
    expect(pill).toMatchObject({ kind: 'tilt', name: 'Tilt Red', color: '#ef4444', model: { velocitySource: 'computed' } });
    expect(pill.live.latest).toMatchObject({ gravity: 1.05, temperature: 20 });
    // It can have a brew, as it measures gravity.
    expect(t.brews.start(pill.id, { name: 'Red ale' })).toMatchObject({ pillId: pill.id });
  });

  it('is recorded once a minute, from what it last sent', () => {
    const t = setup();
    t.hear(TILT, APPLE_COMPANY_ID, encodeTilt({ color: 'Red', tempF: 68, sg: 1.05 }));
    const id = t.pills.adopt(TILT, {}).id;
    const count = () => t.store.countReadings(id);
    const first = count();
    for (let i = 0; i < 30; i++) {
      t.advance(5000);
      // BlueZ only passes the data on when it changes; otherwise only that it was heard.
      if (i === 3) t.hear(TILT, APPLE_COMPANY_ID, encodeTilt({ color: 'Red', tempF: 67, sg: 1.048 }));
      else t.hear(TILT, APPLE_COMPANY_ID, null, { rssi: null });
    }
    expect(count() - first).toBe(Math.floor((30 * 5000) / THERMOMETER_SAMPLE_MS));
    expect(t.pills.latest(id)).toMatchObject({ gravity: 1.048, temperature: expect.closeTo(19.4444, 3) });
    // A Tilt's CSV is a pill's (without accelerometer values).
    const csv = [...csvLines(t.store, t.pills.get(id)!, 0, t.now() + 1)];
    expect(csv[0]).toContain('gravity_sg');
    expect(csv.at(-1)).toContain('1.04800');
  });
});

describe('a RAPT Laser Level', () => {
  const advert = (distance: number, extra: Partial<Parameters<typeof encodeRaptLaser>[0]> = {}) =>
    encodeRaptLaser({ mac: LASER, distance, battery: 86, temp: 4, ...extra });

  it('is listed nearby, and added with a 19 L keg that says how full it is', () => {
    const t = setup();
    t.hear(LASER, RAPT_COMPANY_ID, advert(293));
    expect(t.pills.nearby()).toEqual([
      expect.objectContaining({
        address: LASER,
        kind: 'laser-level',
        info: expect.objectContaining({ deviceType: 'RAPT Laser Level', firmware: '1.0' }),
      }),
    ]);
    const pill = t.pills.adopt(LASER, {});
    expect(pill).toMatchObject({ kind: 'laser-level', name: 'RAPT Laser Level 5566', vessel: DEFAULT_VESSEL });
    // (560 − 293) / (560 − 26) = 50 %: 9.5 of its 19 L.
    expect(pill.live.latest).toMatchObject({
      distance: 293,
      fill: 50,
      volume: 9.5,
      temperature: 4,
      battery: 86,
      gravity: null,
      tilt: null,
    });
  });

  it('works out how full a different keg is, and only a Laser Level has one', () => {
    const t = setup();
    t.hear(LASER, RAPT_COMPANY_ID, advert(158));
    const id = t.pills.adopt(LASER, {}).id;
    const pill = t.pills.update(id, { vessel: { capacity: 9.5, emptyMm: 290, fullMm: 26 } });
    expect(pill.live.latest).toMatchObject({ distance: 158, fill: 50, volume: 4.75 });
    t.hear(TILT, APPLE_COMPANY_ID, encodeTilt({ color: 'Red', tempF: 68, sg: 1.05 }));
    const tilt = t.pills.adopt(TILT, {}).id;
    expect(() => t.pills.update(tilt, { name: 'Renamed', vessel: DEFAULT_VESSEL })).toThrow(/Laser Level/);
    expect(t.pills.get(tilt)?.name).toBe('Tilt Red');
  });

  it("is recorded once a minute with its distance, can't have a brew, and exports how full it was", () => {
    const t = setup();
    t.hear(LASER, RAPT_COMPANY_ID, advert(300));
    const id = t.pills.adopt(LASER, {}).id;
    for (let i = 0; i < 12; i++) {
      t.advance(10_000);
      t.hear(LASER, RAPT_COMPANY_ID, i === 6 ? advert(400) : null, i === 6 ? {} : { rssi: null });
    }
    expect(t.store.latestReadings(id, 1)[0]).toMatchObject({ distance: 400, sg: null, temp: 4 });
    expect(() => t.brews.start(id, {})).toThrow(BrewError);
    expect(() => t.brews.start(id, {})).toThrow(/Laser Level/);
    const csv = [...csvLines(t.store, t.pills.get(id)!, 0, t.now() + 1)];
    expect(csv[0]).toBe('timestamp,unix_ms,distance_mm,fill_percent,volume_litres,temperature_c,temperature_f,battery_percent,rssi_dbm\n');
    expect(csv.at(-1)).toMatch(/,400,30\.0,5\.69,4\.00,39\.20,86\.0,-60\n$/);
  });

  it("isn't recorded from adverts without its distance and temperature", () => {
    const t = setup();
    t.hear(LASER, RAPT_COMPANY_ID, advert(300, { temp: null }));
    expect(t.pills.nearby()[0]).toMatchObject({ kind: 'laser-level', latest: null });
    const id = t.pills.adopt(LASER, {}).id;
    t.advance(THERMOMETER_SAMPLE_MS);
    t.hear(LASER, RAPT_COMPANY_ID, hex('5054a1'));
    expect(t.store.countReadings(id)).toBe(0);
  });

  it('has its own MQTT entities and state fields', () => {
    const names = (kind: 'laser-level' | 'tilt' | 'pill') => MQTT_ENTITIES.filter((e) => hasEntity({ kind }, e)).map((e) => e.object);
    expect(names('laser-level')).toEqual(['temperature', 'battery', 'signal_strength', 'volume', 'fill', 'distance', 'last_reading']);
    expect(names('tilt')).not.toContain('battery');
    expect(names('tilt')).not.toContain('tilt');
    expect(names('tilt')).toContain('gravity');
    expect(names('pill')).not.toContain('volume');
    const t = setup();
    t.hear(LASER, RAPT_COMPANY_ID, advert(293));
    const pill = t.pills.adopt(LASER, {});
    expect(statePayload(pill, pill.live.latest!)).toMatchObject({ distance: 293, fill: 50, volume: 9.5, gravity: null });
  });
});

describe('kegs', () => {
  const advert = (distance: number) => encodeRaptLaser({ mac: LASER, distance, battery: 86, temp: 4 });

  function kegged() {
    const t = setup();
    const kegs = new KegService(t.store, t.pills, silent, t.now);
    t.hear(LASER, RAPT_COMPANY_ID, advert(500));
    const id = t.pills.adopt(LASER, {}).id;
    t.advance(1000);
    return { ...t, kegs, id };
  }

  it('kegs a beer up on a Laser Level only, with what it is all optional, and shows it on the device', () => {
    const t = kegged();
    t.hear(TILT, APPLE_COMPANY_ID, encodeTilt({ color: 'Red', tempF: 68, sg: 1.05 }));
    const tilt = t.pills.adopt(TILT, {}).id;
    expect(() => t.kegs.start(tilt, {})).toThrow(/Laser Level/);

    const keg = t.kegs.start(t.id, { name: '  Pale ale ', style: 'APA', abv: 5.234, brewId: 'b1' });
    expect(keg).toMatchObject({ pillId: t.id, name: 'Pale ale', style: 'APA', abv: 5.23, brewId: 'b1', endedAt: null, startVolume: null });
    expect(t.kegs.start(t.id, {}).name).toBe('');
    // A pill has no keg; a Laser Level shows its own.
    expect(t.pills.get(t.id)?.keg).toMatchObject({ name: '' });
  });

  it('knows how much went in from the fullest it was in the hours after kegging up, and keeps it', () => {
    const t = kegged();
    const keg = t.kegs.start(t.id, { name: 'Stout' });
    expect(keg.startVolume).toBeNull();
    // Filled a minute later, then poured from.
    t.advance(60_000);
    t.hear(LASER, RAPT_COMPANY_ID, advert(293));
    t.advance(60_000);
    t.hear(LASER, RAPT_COMPANY_ID, advert(350));
    // (560 − 293) / (560 − 26) of 19 L.
    expect(t.kegs.get(keg.id)?.startVolume).toBe(9.5);
    expect(t.pills.get(t.id)?.keg?.startVolume).toBe(9.5);
    // Kept once those hours are over, so pruning the readings doesn't lose it; with a smaller keg set up, it's worked
    // out again from that.
    t.advance(7 * 3_600_000);
    expect(t.kegs.get(keg.id)?.startVolume).toBe(9.5);
    t.store.pruneRaw(t.now() + 1);
    expect(t.kegs.get(keg.id)?.startVolume).toBe(9.5);
    t.pills.update(t.id, { vessel: { capacity: 9.5, emptyMm: 560, fullMm: 26 } });
    expect(t.kegs.get(keg.id)?.startVolume).toBe(4.75);
  });

  it('ends the beer before when another is kegged up, and can be emptied, changed and removed', () => {
    const t = kegged();
    const first = t.kegs.start(t.id, { name: 'IPA' });
    t.advance(DAY);
    expect(() => t.kegs.start(t.id, { keggedAt: first.keggedAt - 1 })).toThrow(/after that/);
    const second = t.kegs.start(t.id, { name: 'Lager' });
    expect(t.kegs.get(first.id)?.endedAt).toBe(second.keggedAt);
    expect(t.kegs.activeFor(t.id)?.id).toBe(second.id);
    expect(t.kegs.list(t.id).map((k) => k.name)).toEqual(['Lager', 'IPA']);

    expect(t.kegs.update(second.id, { abv: null, style: 'Helles' })).toMatchObject({ name: 'Lager', style: 'Helles', abv: null });
    expect(() => t.kegs.update(first.id, { endedAt: null })).toThrow(/Another beer/);
    t.advance(DAY);
    expect(t.kegs.end(second.id).endedAt).toBe(t.now());
    expect(() => t.kegs.end(second.id)).toThrow(/already/);
    expect(t.pills.get(t.id)?.keg).toBeNull();
    t.kegs.delete(first.id);
    expect(t.kegs.list(t.id).map((k) => k.id)).toEqual([second.id]);
    // Removing the device removes its kegs.
    t.pills.remove(t.id);
    expect(t.kegs.list()).toEqual([]);
  });

  it('has its own unit, only on a Laser Level', () => {
    const t = kegged();
    expect(t.pills.get(t.id)?.servingUnit).toBeNull();
    expect(t.pills.update(t.id, { servingUnit: { ml: 330, name: 'cans' } }).servingUnit).toEqual({ ml: 330, name: 'cans' });
    expect(t.pills.update(t.id, { servingUnit: null }).servingUnit).toBeNull();
    t.hear(TILT, APPLE_COMPANY_ID, encodeTilt({ color: 'Red', tempF: 68, sg: 1.05 }));
    const tilt = t.pills.adopt(TILT, {}).id;
    expect(() => t.pills.update(tilt, { servingUnit: { ml: 330, name: 'cans' } })).toThrow(/Laser Level/);
    expect(volumeScale('custom', { ml: 330, name: 'cans' })).toEqual({ perLitre: 1000 / 330, symbol: 'cans', decimals: 0 });
    expect(volumeScale('custom', null)).toEqual(volumeScale('l'));
    expect(19 * volumeScale('pint-uk').perLitre).toBeCloseTo(33.44, 2);
    expect(19 * volumeScale('gal').perLitre).toBeCloseTo(5.02, 2);
  });
});

describe('vesselFill', () => {
  it('stays between empty and full, and needs a distance', () => {
    expect(vesselFill(10, DEFAULT_VESSEL)).toEqual({ fill: 100, volume: 19, level: 534 });
    expect(vesselFill(600, DEFAULT_VESSEL)).toEqual({ fill: 0, volume: 0, level: 0 });
    expect(vesselFill(null, DEFAULT_VESSEL)).toBeNull();
  });
});

describe('relays', () => {
  it("pass on Tilts' and Laser Levels' adverts, and not other iBeacons", () => {
    const relayed = (companyId: number, data: Buffer) =>
      advertFromRelay({ address: TILT, rssi: -70, manufacturerData: { [companyId]: data.toString('hex') } }, 'shed', 1000, 1000);
    expect(relayed(APPLE_COMPANY_ID, encodeTilt({ color: 'Blue', tempF: 60, sg: 1.02 }))?.manufacturer?.has(APPLE_COMPANY_ID)).toBe(true);
    expect(relayed(RAPT_COMPANY_ID, encodeRaptLaser({ mac: LASER, distance: 300, battery: 80, temp: 4 }))).not.toBeNull();
    expect(relayed(APPLE_COMPANY_ID, encodeRaptThermometer(18))).not.toBeNull();
    expect(relayed(APPLE_COMPANY_ID, hex('0215f7826da64fa24e988024bc5b71e0893e0044041ac5'))).toBeNull();
  });
});
