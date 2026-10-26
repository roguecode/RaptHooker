import { describe, expect, it } from 'vitest';
import {
  APPLE_COMPANY_ID,
  decodeRapt,
  encodeRaptThermometer,
  encodeRaptV2,
  isThermometerBeacon,
  KEG_COMPANY_ID,
  RAPT_COMPANY_ID,
} from '../ble/rapt.js';
import { manufacturerMap } from '../ble/bluez.js';
import { tiltOf } from '../db.js';
import { CAPTURED } from './helpers.js';

const hex = (h: string) => Buffer.from(h, 'hex');

describe('RAPT decoder', () => {
  it('decodes a real v2 metrics advert', () => {
    const d = decodeRapt(RAPT_COMPANY_ID, hex(CAPTURED.metricsFalling));
    expect(d?.kind).toBe('metrics');
    if (d?.kind !== 'metrics') return;
    expect(d.metrics.version).toBe(2);
    expect(d.metrics.temp).toBeCloseTo(20.06, 2);
    expect(d.metrics.sg).toBeCloseTo(1.0546, 4);
    expect(d.metrics.velocity).toBeCloseTo(-0.0084, 3);
    expect(d.metrics.battery).toBe(100);
    expect([d.metrics.x, d.metrics.y, d.metrics.z]).toEqual([657.6875, 800.1875, -134.125]);
    expect(d.metrics.mac).toBeNull();
  });

  it('reads the gravity velocity sign', () => {
    const d = decodeRapt(RAPT_COMPANY_ID, hex(CAPTURED.metricsRising));
    expect(d?.kind === 'metrics' && d.metrics.velocity).toBeCloseTo(0.248, 3);
  });

  it('decodes the firmware and device type adverts', () => {
    // The company ids BlueZ reports for a real pill ("RA" and "KE", little-endian).
    expect(RAPT_COMPANY_ID).toBe(16722);
    expect(KEG_COMPANY_ID).toBe(17739);
    expect(decodeRapt(17739, hex(CAPTURED.firmware))).toEqual({ kind: 'firmware', firmware: '20250319_055542_b3788ba' });
    expect(decodeRapt(16722, hex(CAPTURED.deviceType))).toEqual({ kind: 'deviceType', deviceType: 'PillG1' });
  });

  it('decodes v1 with its registration MAC', () => {
    const v2 = hex(CAPTURED.metricsFalling);
    const v1 = Buffer.concat([Buffer.from('PT', 'latin1'), Buffer.from([1, 0x08, 0xb6, 0x1f, 0, 0, 0x64]), v2.subarray(9)]);
    const d = decodeRapt(RAPT_COMPANY_ID, v1);
    expect(d?.kind === 'metrics' && d.metrics).toMatchObject({ version: 1, mac: '08:B6:1F:00:00:64', velocity: null });
  });

  it('marks velocity invalid when the flag is off', () => {
    const b = hex(CAPTURED.metricsFalling);
    b[4] = 0;
    const d = decodeRapt(RAPT_COMPANY_ID, b);
    expect(d?.kind === 'metrics' && d.metrics.velocity).toBeNull();
  });

  it('keeps readings with a meaningless gravity (pill out of liquid)', () => {
    const d = decodeRapt(RAPT_COMPANY_ID, hex(CAPTURED.metricsOutOfLiquid));
    expect(d?.kind).toBe('metrics');
    if (d?.kind !== 'metrics') return;
    expect(d.metrics.sg).toBeCloseTo(0.2057, 4);
    expect(d.metrics.temp).toBeCloseTo(14.936, 3);
    expect(d.metrics.battery).toBe(100);
  });

  it('ignores other payloads', () => {
    expect(decodeRapt(0x004c, hex(CAPTURED.metricsFalling))).toBeNull();
    expect(decodeRapt(RAPT_COMPANY_ID, hex('5054020001'))).toBeNull();
    expect(decodeRapt(RAPT_COMPANY_ID, hex('0000000000000000000000000000000000000000000000'))).toBeNull();
    const nan = hex(CAPTURED.metricsFalling);
    nan.writeFloatBE(Number.NaN, 11);
    expect(decodeRapt(RAPT_COMPANY_ID, nan)).toBeNull();
  });

  it('round-trips through the encoder', () => {
    const d = decodeRapt(
      RAPT_COMPANY_ID,
      encodeRaptV2({ sg: 1.0421, temp: 18.5, velocity: -3.5, battery: 87.5, x: 100, y: -20.5, z: 900 }),
    );
    expect(d?.kind === 'metrics' && d.metrics).toMatchObject({
      sg: expect.closeTo(1.0421, 5),
      temp: expect.closeTo(18.5, 1),
      velocity: -3.5,
      battery: 87.5,
      x: 100,
      y: -20.5,
      z: 900,
    });
  });

  it('gives the same fingerprint for the same payload', () => {
    const a = decodeRapt(RAPT_COMPANY_ID, hex(CAPTURED.metricsFalling));
    const b = decodeRapt(RAPT_COMPANY_ID, hex(CAPTURED.metricsFalling));
    const c = decodeRapt(RAPT_COMPANY_ID, hex(CAPTURED.metricsRising));
    expect(a?.kind === 'metrics' && a.fingerprint).toBe(b?.kind === 'metrics' && b.fingerprint);
    expect(a?.kind === 'metrics' && a.fingerprint).not.toBe(c?.kind === 'metrics' && c.fingerprint);
  });
});

describe('RAPT Thermometer decoder', () => {
  it('reads the temperatures the RAPT app showed', () => {
    expect(decodeRapt(APPLE_COMPANY_ID, hex(CAPTURED.thermometerRest))).toEqual({ kind: 'thermometer', temp: 15.3 });
    expect(decodeRapt(APPLE_COMPANY_ID, hex(CAPTURED.thermometerWarm))).toEqual({ kind: 'thermometer', temp: 32.4 });
    expect(decodeRapt(APPLE_COMPANY_ID, hex(CAPTURED.thermometerIced))).toEqual({ kind: 'thermometer', temp: 0 });
  });

  it('rounds to the 0.1 °C steps the thermometer measures in', () => {
    // 0x4816 is 15.19 °C as sent.
    const b = hex(CAPTURED.thermometerRest);
    b.writeUInt16BE(0x4816, 18);
    expect(decodeRapt(APPLE_COMPANY_ID, b)).toEqual({ kind: 'thermometer', temp: 15.2 });
  });

  it('only takes iBeacons with KegLand UUIDs', () => {
    expect(isThermometerBeacon(hex(CAPTURED.thermometerRest))).toBe(true);
    const other = hex(CAPTURED.thermometerRest);
    other[2] = 0x00;
    expect(decodeRapt(APPLE_COMPANY_ID, other)).toBeNull();
    const noLand = hex(CAPTURED.thermometerRest);
    noLand[17] = 0x00;
    expect(decodeRapt(APPLE_COMPANY_ID, noLand)).toBeNull();
    expect(decodeRapt(APPLE_COMPANY_ID, hex(CAPTURED.thermometerRest).subarray(0, 22))).toBeNull();
    // The same bytes under another company id aren't a thermometer.
    expect(decodeRapt(RAPT_COMPANY_ID, hex(CAPTURED.thermometerRest))).toBeNull();
  });

  it('drops temperatures it could never measure', () => {
    const b = hex(CAPTURED.thermometerRest);
    b.writeUInt16BE(0, 18);
    expect(decodeRapt(APPLE_COMPANY_ID, b)).toBeNull();
    b.writeUInt16BE(0xffff, 18);
    expect(decodeRapt(APPLE_COMPANY_ID, b)).toBeNull();
  });

  it('round-trips through the encoder', () => {
    for (const temp of [-5.5, 0, 15.3, 32.4, 99.9]) {
      expect(decodeRapt(APPLE_COMPANY_ID, encodeRaptThermometer(temp))).toEqual({ kind: 'thermometer', temp });
    }
    expect(encodeRaptThermometer(15.3).toString('hex')).toBe(CAPTURED.thermometerRest);
  });
});

describe('tilt', () => {
  it('is 0 upright and 90 lying flat', () => {
    expect(tiltOf(0, 0, 1000)).toBeCloseTo(0);
    expect(tiltOf(1000, 0, 0)).toBeCloseTo(90);
    expect(tiltOf(0, 0, 0)).toBeNull();
  });
});

describe('BlueZ manufacturer data', () => {
  it('unwraps dbus-next variants keyed by company id', () => {
    const map = manufacturerMap({ signature: 'a{qv}', value: { 16722: { signature: 'ay', value: hex(CAPTURED.metricsFalling) } } });
    expect(map?.get(RAPT_COMPANY_ID)?.length).toBe(23);
  });
});
