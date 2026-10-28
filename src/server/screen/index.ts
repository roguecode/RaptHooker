import { defaultScreenOptions, parseScreenQuery, type History, type Pill, type ScreenFormat, type ScreenOptions } from '@rapthooker/shared';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { PillService } from '../pills.js';
import type { Settings } from '../settings.js';
import { TextMeasure, type ScreenAssets } from './assets.js';
import { loadScreenAssets } from './assets-files.js';
import { SCREEN_COLORS } from './palette.js';
import { CONTENT_TYPES, rasterize } from './raster.js';
import { renderScreen, type ScreenDevice, type ScreenScene } from './render.js';
import { screenStrings } from './strings.js';

const DAY = 86_400_000;
const RANGE_MS = { '1d': DAY, '3d': 3 * DAY, '7d': 7 * DAY } as const;
/** The same address within this long gets the same picture (screens and the app's preview can ask often). */
const CACHE_MS = 10_000;
const CACHE_SIZE = 8;
/** Bigger pictures (a large BMP, say) aren't kept, to spare a small Pi's memory. */
const CACHE_MAX_BYTES = 2_000_000;

export interface ScreenImage {
  status: number;
  type: string;
  body: Buffer;
}

interface Deps {
  store: Store;
  pills: PillService;
  settings: Settings;
  config: Config;
}

/** Screen images: gathers what a picture shows, draws it and turns it into PNG, JPEG or BMP. */
export class ScreenService {
  private assets: ScreenAssets | null = null;
  private measure: TextMeasure | null = null;
  /** Pictures are drawn one at a time, so a few screens refreshing at once don't swamp a small Pi. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, { at: number; image: Promise<ScreenImage> }>();

  constructor(
    private readonly deps: Deps,
    private readonly loadAssets: () => ScreenAssets = loadScreenAssets,
  ) {}

  /** The options an address asks for, with the hub's units as the defaults. */
  options(query: Record<string, unknown>): ScreenOptions {
    return parseScreenQuery(query, defaultScreenOptions(this.deps.settings.units()));
  }

  /** The picture of one device (`pillId`) or of all of them. */
  image(pillId: string | null, format: ScreenFormat, query: Record<string, unknown>, now = Date.now()): Promise<ScreenImage> {
    const opts = this.options(query);
    const key = JSON.stringify([pillId, format, opts]);
    for (const [k, v] of this.cache) if (now - v.at > CACHE_MS) this.cache.delete(k);
    const hit = this.cache.get(key);
    if (hit) return hit.image;
    const job = this.queue.then(() => this.draw(pillId, format, opts, now));
    this.queue = job.catch(() => undefined);
    const entry = { at: now, image: job };
    this.cache.set(key, entry);
    const forget = () => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    };
    job.then((image) => image.body.length > CACHE_MAX_BYTES && forget(), forget);
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return job;
  }

  /** The SVG a picture is drawn from (also used by the tests). */
  svg(pillId: string | null, opts: ScreenOptions, now = Date.now()): { svg: string; found: boolean } {
    const scene = this.scene(pillId, opts, now);
    const measure = (this.measure ??= new TextMeasure(this.ensureAssets().fonts));
    const svg = renderScreen(scene, opts, { measure, strings: screenStrings(opts.lang, opts.tz) });
    return { svg, found: !scene.single || scene.devices.length > 0 };
  }

  private ensureAssets(): ScreenAssets {
    return (this.assets ??= this.loadAssets());
  }

  private async draw(pillId: string | null, format: ScreenFormat, opts: ScreenOptions, now: number): Promise<ScreenImage> {
    const { svg, found } = this.svg(pillId, opts, now);
    const body = await rasterize(svg, format, this.ensureAssets(), SCREEN_COLORS[opts.palette][opts.theme].bg);
    return { status: found ? 200 : 404, type: CONTENT_TYPES[format], body };
  }

  private scene(pillId: string | null, opts: ScreenOptions, now: number): ScreenScene {
    const { pills, settings } = this.deps;
    let list: Pill[];
    if (pillId) {
      const one = pills.get(pillId);
      list = one ? [one] : [];
    } else {
      list = pills.list().filter((p) => !p.archived && (!opts.brewing || p.brew));
    }
    return {
      hubName: settings.hub().name,
      now,
      single: pillId !== null,
      brewingOnly: pillId === null && opts.brewing,
      devices: list.map((pill) => this.device(pill, opts, now)),
    };
  }

  private history(pill: Pill, from: number, to: number, points: number): History {
    const { store, pills, config } = this.deps;
    return store.history(pill.id, from, to, {
      maxPoints: points,
      gapMs: pills.gapMs(pill.id),
      offsets: pill.offsets,
      model: pill.model,
      rawFrom: config.rawRetentionDays > 0 ? Date.now() - config.rawRetentionDays * DAY : undefined,
    });
  }

  private device(pill: Pill, opts: ScreenOptions, now: number): ScreenDevice {
    const chart = opts.show.includes('chart');
    const brew = pill.kind === 'pill' ? pill.brew : null;
    const from = opts.range === 'brew' ? (brew ? Math.min(brew.startedAt, now - 3_600_000) : now - DAY) : now - RANGE_MS[opts.range];
    const points = Math.max(60, Math.min(360, Math.round(opts.width / 2)));
    const history = chart ? this.history(pill, from, now, points) : null;
    let day: ScreenDevice['day'] = null;
    if (pill.kind === 'thermometer' && opts.show.includes('stats')) {
      const last = history && from === now - DAY ? history : this.history(pill, now - DAY, now, 96);
      let min = Infinity;
      let max = -Infinity;
      for (const v of last.temperature) {
        if (v === null) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      day = min <= max ? { min, max } : null;
    }
    return { pill, history, from, to: now, day };
  }
}
