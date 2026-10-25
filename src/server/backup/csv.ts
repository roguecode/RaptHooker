import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Brew, Pill } from '@rapthooker/shared';
import type { Store } from '../db.js';
import { csvLines } from '../routes/csv.js';
import { localDate } from './files.js';

/** Brews that were running at some point in this many days go into the weekly CSV backup. */
export const CSV_BREW_DAYS = 60;
/** Each pill's readings from this many days. */
export const CSV_PILL_DAYS = 7;

const DAY = 86_400_000;

const safeName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60) || 'unnamed';

/**
 * Writes the weekly CSV backup into `dir` (replacing it): every brew from the last 60 days
 * (brew-YYYY-MM-DD-name.csv, dated by its start) and each pill's readings from the last 7 days
 * (pill-name-last-7-days.csv). Returns the file names.
 */
export async function writeWeeklyCsv(store: Store, pills: Pill[], brews: Brew[], dir: string, now: number): Promise<string[]> {
  const tmp = `${dir}.partial`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const names = new Set<string>();
  const unique = (base: string, id: string) => {
    const name = names.has(`${base}.csv`) ? `${base}-${id.slice(0, 8)}.csv` : `${base}.csv`;
    names.add(name);
    return name;
  };
  const write = (name: string, pill: Pill, from: number, to: number) =>
    pipeline(Readable.from(csvLines(store, pill, from, to)), createWriteStream(join(tmp, name)));
  try {
    const byId = new Map(pills.map((p) => [p.id, p]));
    for (const brew of [...brews].sort((a, b) => a.startedAt - b.startedAt)) {
      const end = brew.endedAt ?? now;
      const pill = byId.get(brew.pillId);
      if (end < now - CSV_BREW_DAYS * DAY || !pill) continue;
      await write(unique(`brew-${localDate(new Date(brew.startedAt))}-${safeName(brew.name)}`, brew.id), pill, brew.startedAt, end);
    }
    for (const pill of pills) {
      const from = now - CSV_PILL_DAYS * DAY;
      if (store.countReadings(pill.id, from) === 0) continue;
      await write(unique(`pill-${safeName(pill.name)}-last-${CSV_PILL_DAYS}-days`, pill.id), pill, from, now);
    }
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return [...names];
}
