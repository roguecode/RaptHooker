import type { TemplateContext, TemplateValue } from './template.js';
import type { Brew, GravityUnit, PillInfo, Reading, TemperatureUnit } from './types.js';
import { cToF, gravityIn, points, round, sgToPlato, temperatureIn } from './units.js';

export type VariableGroup = 'Pill' | 'Reading' | 'Brew' | 'Time' | 'Other' | 'Batch';

export interface VariableDef {
  key: string;
  group: VariableGroup;
  description: string;
}

export const VARIABLES: VariableDef[] = [
  { key: 'name', group: 'Pill', description: 'The name you gave the pill' },
  { key: 'name_slug', group: 'Pill', description: 'The name in lower case with dashes (for URLs and device labels)' },
  { key: 'pill_id', group: 'Pill', description: "RaptHooker's id for the pill" },
  { key: 'chip_id', group: 'Pill', description: 'A number from the last 3 bytes of the Bluetooth address (like an iSpindel ID)' },
  { key: 'address', group: 'Pill', description: 'Bluetooth address' },
  { key: 'rapt_id', group: 'Pill', description: 'The MAC address the RAPT app shows' },
  { key: 'firmware', group: 'Pill', description: 'Firmware version' },
  { key: 'device_type', group: 'Pill', description: 'Device type, e.g. PillG1' },
  { key: 'gravity', group: 'Reading', description: "Gravity in the webhook's unit (SG or °P)" },
  { key: 'gravity_unit', group: 'Reading', description: '"G" for SG or "P" for Plato (Brewfather/Brewer\'s Friend style)' },
  { key: 'gravity_label', group: 'Reading', description: '"SG" or "°P"' },
  { key: 'gravity_sg', group: 'Reading', description: 'Specific gravity, e.g. 1.0465' },
  { key: 'gravity_plato', group: 'Reading', description: 'Degrees Plato' },
  { key: 'gravity_points', group: 'Reading', description: 'Gravity points, e.g. 46.5' },
  { key: 'temperature', group: 'Reading', description: "Temperature in the webhook's unit" },
  { key: 'temp_unit', group: 'Reading', description: '"C" or "F"' },
  { key: 'temperature_c', group: 'Reading', description: 'Temperature, °C' },
  { key: 'temperature_f', group: 'Reading', description: 'Temperature, °F' },
  { key: 'velocity', group: 'Reading', description: 'Gravity change, points per day (null until there is enough data)' },
  { key: 'plausible', group: 'Reading', description: 'true when the pill looks like it is floating, false when the reading looks wrong' },
  {
    key: 'pill_gravity_sg',
    group: 'Reading',
    description: 'The gravity the pill itself sent (SG), even when RaptHooker works it out from the tilt',
  },
  { key: 'pill_velocity', group: 'Reading', description: 'The velocity the pill itself sent, points per day' },
  { key: 'battery', group: 'Reading', description: 'Battery, %' },
  { key: 'rssi', group: 'Reading', description: 'Bluetooth signal at the hub, dBm' },
  { key: 'tilt', group: 'Reading', description: 'Angle from vertical, degrees' },
  { key: 'accel_x', group: 'Reading', description: 'Accelerometer X' },
  { key: 'accel_y', group: 'Reading', description: 'Accelerometer Y' },
  { key: 'accel_z', group: 'Reading', description: 'Accelerometer Z' },
  { key: 'timestamp', group: 'Time', description: 'Time of the reading, ISO 8601 (UTC)' },
  { key: 'timestamp_unix', group: 'Time', description: 'Time of the reading, seconds since 1970' },
  { key: 'timestamp_ms', group: 'Time', description: 'Time of the reading, milliseconds since 1970' },
  { key: 'age_seconds', group: 'Time', description: 'How old the reading is when sent' },
  { key: 'interval', group: 'Time', description: "This webhook's interval, seconds" },
  { key: 'brew_id', group: 'Brew', description: 'Id of the brew running on the pill ("" when none)' },
  { key: 'brew_name', group: 'Brew', description: 'Brew name' },
  { key: 'brew_style', group: 'Brew', description: 'Beer style' },
  { key: 'brew_og', group: 'Brew', description: "Original gravity, in the webhook's gravity unit" },
  { key: 'brew_target_fg', group: 'Brew', description: "Target final gravity, in the webhook's gravity unit" },
  { key: 'brew_abv', group: 'Brew', description: 'ABV so far, %' },
  { key: 'brew_attenuation', group: 'Brew', description: 'Apparent attenuation so far, %' },
  { key: 'brew_days', group: 'Brew', description: 'Days since the brew started' },
  { key: 'brew_started', group: 'Brew', description: 'When the brew started, ISO 8601' },
  { key: 'hub_name', group: 'Other', description: 'The name of this hub' },
  { key: 'app', group: 'Other', description: '"RaptHooker"' },
  { key: 'app_version', group: 'Other', description: 'RaptHooker version' },
];

/** Variables for the batch body (and the URL and headers) when every pill goes in one request. */
export const BATCH_VARIABLES: VariableDef[] = [
  { key: 'items', group: 'Batch', description: "Every pill's rendered body, separated by commas (JSON) or new lines (text)" },
  { key: 'count', group: 'Batch', description: 'How many pills are in this request' },
  { key: 'timestamp', group: 'Batch', description: 'When the request is sent, ISO 8601 (UTC)' },
  { key: 'timestamp_unix', group: 'Batch', description: 'When the request is sent, seconds since 1970' },
  { key: 'timestamp_ms', group: 'Batch', description: 'When the request is sent, milliseconds since 1970' },
  { key: 'interval', group: 'Batch', description: "This webhook's interval, seconds" },
  { key: 'hub_name', group: 'Batch', description: 'The name of this hub' },
  { key: 'app', group: 'Batch', description: '"RaptHooker"' },
  { key: 'app_version', group: 'Batch', description: 'RaptHooker version' },
];

/** Variables for a batch request (everything but `items`, which is inserted as it is). */
export function buildBatchContext(input: {
  count: number;
  now: number;
  intervalSec: number;
  appVersion: string;
  hubName?: string;
}): TemplateContext {
  return {
    count: input.count,
    timestamp: new Date(input.now).toISOString(),
    timestamp_unix: Math.floor(input.now / 1000),
    timestamp_ms: input.now,
    interval: input.intervalSec,
    hub_name: input.hubName ?? 'RaptHooker',
    app: 'RaptHooker',
    app_version: input.appVersion,
  };
}

export interface ContextInput {
  pill: { id: string; name: string; address: string; raptId: string; info: PillInfo };
  reading: Reading;
  brew: Brew | null;
  gravityUnit: GravityUnit;
  temperatureUnit: TemperatureUnit;
  intervalSec: number;
  now: number;
  appVersion: string;
  hubName?: string;
}

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'pill'
  );
}

const num = (value: number | null | undefined, decimals: number): number | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : round(value, decimals);

/** All template variables for one reading. */
export function buildContext(input: ContextInput): TemplateContext {
  const { pill, reading, brew, gravityUnit, temperatureUnit } = input;
  const hex = pill.address.replace(/[^0-9a-f]/gi, '');
  const ctx: Record<string, TemplateValue> = {
    name: pill.name,
    name_slug: slugify(pill.name),
    pill_id: pill.id,
    chip_id: hex.length >= 6 ? parseInt(hex.slice(-6), 16) : 0,
    address: pill.address,
    rapt_id: pill.raptId,
    firmware: pill.info.firmware ?? '',
    device_type: pill.info.deviceType ?? '',
    gravity: gravityIn(reading.gravity, gravityUnit),
    gravity_unit: gravityUnit === 'plato' ? 'P' : 'G',
    gravity_label: gravityUnit === 'plato' ? '°P' : 'SG',
    gravity_sg: round(reading.gravity, 4),
    gravity_plato: round(sgToPlato(reading.gravity), 2),
    gravity_points: round(points(reading.gravity), 1),
    temperature: temperatureIn(reading.temperature, temperatureUnit),
    temp_unit: temperatureUnit,
    temperature_c: round(reading.temperature, 2),
    temperature_f: round(cToF(reading.temperature), 2),
    velocity: num(reading.velocity, 2),
    plausible: reading.plausible,
    pill_gravity_sg: round(reading.pillGravity, 4),
    pill_velocity: num(reading.pillVelocity, 2),
    battery: round(reading.battery, 1),
    rssi: reading.rssi,
    tilt: num(reading.tilt, 2),
    accel_x: round(reading.x, 2),
    accel_y: round(reading.y, 2),
    accel_z: round(reading.z, 2),
    timestamp: new Date(reading.ts).toISOString(),
    timestamp_unix: Math.floor(reading.ts / 1000),
    timestamp_ms: reading.ts,
    age_seconds: Math.max(0, Math.round((input.now - reading.ts) / 1000)),
    interval: input.intervalSec,
    brew_id: brew?.id ?? '',
    brew_name: brew?.name ?? '',
    brew_style: brew?.style ?? '',
    brew_og: brew?.stats.og != null ? gravityIn(brew.stats.og, gravityUnit) : null,
    brew_target_fg: brew?.targetFg != null ? gravityIn(brew.targetFg, gravityUnit) : null,
    brew_abv: num(brew?.stats.abv, 2),
    brew_attenuation: num(brew?.stats.attenuation, 1),
    brew_days: brew ? round((input.now - brew.startedAt) / 86_400_000, 2) : null,
    brew_started: brew ? new Date(brew.startedAt).toISOString() : '',
    hub_name: input.hubName ?? 'RaptHooker',
    app: 'RaptHooker',
    app_version: input.appVersion,
  };
  return ctx;
}

/** A plausible reading for previews when a pill hasn't been heard yet. */
export function sampleReading(now: number): Reading {
  return {
    ts: now - 42_000,
    gravity: 1.0213,
    temperature: 19.6,
    velocity: -4.2,
    battery: 92,
    rssi: -61,
    tilt: 38.5,
    x: 410.5,
    y: -120.25,
    z: 812.75,
    plausible: true,
    pillGravity: 1.0213,
    pillVelocity: -4.2,
  };
}
