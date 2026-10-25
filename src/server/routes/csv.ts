import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { cToF, sgToPlato, type Pill } from '@rapthooker/shared';
import type { Store } from '../db.js';
import { calibrate } from '../pills.js';

const csvNumber = (v: number | null, d: number) => (v === null || !Number.isFinite(v) ? '' : v.toFixed(d));

/**
 * A pill's calibrated readings between two times as CSV lines (the header first). The gravity is the one the pill's
 * model uses (unsmoothed), next to the gravity the pill sent. Also used by the weekly CSV backups.
 */
export function* csvLines(store: Store, pill: Pill, from: number, to: number): Generator<string> {
  const { offsets, model } = pill;
  yield 'timestamp,unix_ms,gravity_sg,gravity_plato,temperature_c,temperature_f,velocity_points_per_day,battery_percent,rssi_dbm,tilt_degrees,accel_x,accel_y,accel_z,pill_gravity_sg,plausible\n';
  for (const raw of store.iterateReadings(pill.id, from, to)) {
    const r = calibrate(raw, offsets, { ...model, smoothing: 'off', velocitySource: 'pill' });
    yield [
      new Date(r.ts).toISOString(),
      r.ts,
      csvNumber(r.gravity, 5),
      csvNumber(sgToPlato(r.gravity), 2),
      csvNumber(r.temperature, 2),
      csvNumber(cToF(r.temperature), 2),
      csvNumber(r.velocity, 3),
      csvNumber(r.battery, 1),
      r.rssi ?? '',
      csvNumber(r.tilt, 2),
      r.x,
      r.y,
      r.z,
      csvNumber(r.pillGravity, 5),
      r.plausible ? 1 : 0,
    ].join(',') + '\n';
  }
}

/** Streams a pill's readings between two times as a CSV download. */
export function sendCsv(store: Store, reply: FastifyReply, pill: Pill, from: number, to: number, filename: string) {
  const safe = filename.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-');
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${safe}"`)
    .send(Readable.from(csvLines(store, pill, from, to)));
}
