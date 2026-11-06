import { z } from 'zod';
import type { DeviceKind } from './types.js';

/**
 * Kinds of device beyond pills, thermometers and iSpindels (see ispindel.ts for those):
 *
 * - tilt: a Tilt hydrometer, heard over Bluetooth (an iBeacon whose UUID says its colour). Gravity and temperature.
 * - laser-level: a RAPT Laser Level, a keg lid that measures the distance down to the beer with a laser, over
 *   Bluetooth. How full the keg is comes from that distance and the keg's size (its `vessel`).
 */

/** A keg (or any vessel with straight sides) a Laser Level sits on. */
export interface Vessel {
  /** Litres when full. */
  capacity: number;
  /** mm from the sensor to the bottom: what it reads when the keg is empty. */
  emptyMm: number;
  /** mm from the sensor to the beer when the keg is full. */
  fullMm: number;
}

/**
 * KegLand's defaults for a 19 L keg: 560 mm down to the bottom, full at 26 mm (as YDraig's rapt-laser-level-display
 * uses, from KegLand's own figures).
 */
export const DEFAULT_VESSEL: Vessel = { capacity: 19, emptyMm: 560, fullMm: 26 };

export const vesselSchema = z
  .object({
    capacity: z.number().min(0.1).max(10_000),
    emptyMm: z.number().min(10).max(6000),
    fullMm: z.number().min(0).max(5990),
  })
  .refine((v) => v.emptyMm > v.fullMm, { message: 'Empty has to be further down than full', path: ['emptyMm'] });

/**
 * How full a vessel is from the distance down to the beer: `fill` 0–100 %, `volume` litres, `level` mm of beer. A
 * straight-sided vessel is assumed. Null without a distance.
 */
export function vesselFill(distance: number | null | undefined, v: Vessel): { fill: number; volume: number; level: number } | null {
  if (distance === null || distance === undefined || !Number.isFinite(distance)) return null;
  const span = v.emptyMm - v.fullMm;
  if (!(span > 0)) return null;
  const level = Math.max(0, Math.min(span, v.emptyMm - distance));
  const fill = (level / span) * 100;
  return {
    fill: Math.round(fill * 10) / 10,
    volume: Math.round(((v.capacity * fill) / 100) * 100) / 100,
    level: Math.round(level),
  };
}

/** Kinds of device that measure the distance down to the beer. */
export const measuresLevel = (kind: DeviceKind | string | undefined): boolean => kind === 'laser-level';

/** A Laser Level's own unit for how much is left, e.g. 330 ml called "cans". */
export interface ServingUnit {
  ml: number;
  /** As shown after the number ("cans"). */
  name: string;
}

export const servingUnitSchema = z.object({ ml: z.number().min(1).max(100_000), name: z.string().trim().min(1).max(20) });

/** Units the volume in a keg is shown in. Stored and sent as litres; these are only for showing it. */
export type VolumeUnit = 'l' | 'gal' | 'pint-uk' | 'pint-us' | 'custom';

export const VOLUME_UNITS: readonly VolumeUnit[] = ['l', 'gal', 'pint-uk', 'pint-us', 'custom'];

/** Litres in one of each unit (custom: the device's own). */
const LITRES_IN: Record<Exclude<VolumeUnit, 'custom'>, number> = {
  l: 1,
  gal: 3.785411784,
  'pint-uk': 0.56826125,
  'pint-us': 0.473176473,
};

const SYMBOLS: Record<Exclude<VolumeUnit, 'custom'>, string> = { l: 'L', gal: 'gal', 'pint-uk': 'pints', 'pint-us': 'pints' };

/**
 * How to show litres in a unit: multiply by `perLitre`, label with `symbol`, and keep `decimals` places. A device
 * without a custom unit of its own is shown in litres when "custom" is picked.
 */
export function volumeScale(unit: VolumeUnit, own?: ServingUnit | null): { perLitre: number; symbol: string; decimals: number } {
  if (unit === 'custom') return own ? { perLitre: 1000 / own.ml, symbol: own.name, decimals: 0 } : volumeScale('l');
  return { perLitre: 1 / LITRES_IN[unit], symbol: SYMBOLS[unit], decimals: unit === 'l' || unit === 'gal' ? 1 : 0 };
}

/** The Tilt's colours, which its UUID says (and which name it in Tilt's apps). */
export const TILT_COLOR_HEX: Record<string, string> = {
  Red: '#ef4444',
  Green: '#22c55e',
  Black: '#71717a',
  Purple: '#a855f7',
  Orange: '#f97316',
  Blue: '#3b82f6',
  Yellow: '#eab308',
  Pink: '#ec4899',
};
