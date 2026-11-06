import {
  batteryPercentFromVolts,
  ispindelAddress,
  ispindelFloating,
  ispindelGravitySg,
  ispindelTempC,
  plausibleGravity,
  type IspindelPost,
} from '@rapthooker/shared';
import { FLAG_IMPLAUSIBLE, type RawReading } from '../db.js';

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/** A post turned into a stored reading, or a reason it can't be one. */
export type IspindelDecoded =
  { ok: true; address: string; name: string | null; intervalSec: number | null; raw: RawReading } | { ok: false; reason: string };

/**
 * An iSpindel's post as a reading at `at`: °C, SG (from its own formula), its tilt and battery voltage, with the
 * battery's charge estimated from the voltage. It isn't floating when it lies flat or stands up, or its gravity is one
 * no beer could have: flagged, like a pill's.
 */
export function decodeIspindel(post: IspindelPost, at: number): IspindelDecoded {
  const temp = ispindelTempC(post.temperature, post.temp_units);
  // Its DS18B20 says -127 °C when it can't be read (and 85 °C straight after power-up, which can't be told apart).
  if (!(temp > -40 && temp < 125)) return { ok: false, reason: 'temperature out of range' };
  const angle = post.angle ?? post.tilt;
  const tilt = finite(angle) && angle >= 0 && angle <= 180 ? Math.round(angle * 1e4) / 1e4 : null;
  const sg = ispindelGravitySg(post.gravity, post['gravity-unit']);
  const voltage = finite(post.battery) && post.battery > 0 && post.battery < 10 ? Math.round(post.battery * 1e4) / 1e4 : null;
  const rssi = finite(post.RSSI) && post.RSSI < 0 && post.RSSI >= -127 ? Math.round(post.RSSI) : null;
  const floating = ispindelFloating(tilt) && (sg === null || plausibleGravity(sg));
  const intervalSec = finite(post.interval) && post.interval > 0 ? Math.round(post.interval) : null;
  return {
    ok: true,
    address: ispindelAddress(post.ID),
    name: post.name?.trim() || null,
    intervalSec,
    raw: {
      ts: at,
      sg,
      temp,
      velocity: null,
      battery: voltage === null ? null : batteryPercentFromVolts(voltage),
      rssi,
      x: null,
      y: null,
      z: null,
      tilt,
      voltage,
      flags: floating ? 0 : FLAG_IMPLAUSIBLE,
    },
  };
}
