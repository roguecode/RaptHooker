import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import {
  DEFAULT_HUB_SETTINGS,
  DEFAULT_PILL_MODEL,
  SCREEN_ITEMS,
  SCREEN_PALETTES,
  type Brew,
  type History,
  type Pill,
  type Reading,
  type ScreenItem,
} from '@rapthooker/shared';
import { parseConfig } from '../config.js';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { WebhookService } from '../webhooks.js';
import { AlertService } from '../alerts.js';
import { Maintenance } from '../maintenance.js';
import { buildServer, Settings } from '../server.js';
import { UnavailableScanner } from '../ble/scanner.js';
import type { PushService } from '../push.js';
import { MqttService } from '../mqtt.js';
import { ChannelService } from '../channels.js';
import { UpdateService } from '../updates.js';
import { SystemService } from '../system.js';
import { TokenService } from '../tokens.js';
import { LogBuffer } from '../logbuffer.js';
import { ScreenService } from '../screen/index.js';
import { TextMeasure, type FontWeight } from '../screen/assets.js';
import { loadScreenAssets } from '../screen/assets-files.js';
import { CSS_VARS, SCREEN_COLORS, gradientStops, parseColor } from '../screen/palette.js';
import { encodeBmp } from '../screen/raster.js';
import { silent, tempStore } from './helpers.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0);
const DAY = 86_400_000;
const assets = loadScreenAssets();
const measure = new TextMeasure(assets.fonts);

// ---------- Sample devices ----------

function reading(over: Partial<Reading> = {}): Reading {
  return {
    ts: NOW - 120_000,
    gravity: 1.0111,
    temperature: 19.2,
    velocity: -2.1,
    battery: 83,
    rssi: -60,
    tilt: 37,
    x: 0,
    y: 0,
    z: 0,
    plausible: true,
    pillGravity: 1.0111,
    pillVelocity: -2.1,
    ...over,
  };
}

function brew(over: Partial<Brew> = {}): Brew {
  return {
    id: 'b1',
    pillId: 'p1',
    name: 'Hazy IPA #4',
    style: 'NEIPA',
    notes: '',
    og: null,
    targetFg: 1.012,
    startedAt: NOW - 8.5 * DAY,
    endedAt: null,
    events: [],
    stats: {
      og: 1.0531,
      ogAuto: true,
      gravity: 1.0111,
      abv: 5.5,
      attenuation: 79,
      tempMin: 18.7,
      tempMax: 20.7,
      tempAvg: 19.4,
      readings: 900,
      firstReadingAt: NOW - 8.5 * DAY,
      lastReadingAt: NOW - 120_000,
      stable: false,
      finalAbv: null,
      prediction: null,
    },
    ...over,
  };
}

function pill(over: Partial<Pill> & { latest?: Reading | null } = {}): Pill {
  const { latest = reading(), ...rest } = over;
  return {
    id: 'p1',
    kind: 'pill',
    address: 'F0:0D:5E:ED:00:03',
    raptId: 'F0:0D:5E:ED:00:01',
    name: 'Hazy IPA',
    color: '#a78bfa',
    createdAt: NOW - 30 * DAY,
    archived: false,
    offsets: { gravity: 0, temperature: 0 },
    model: DEFAULT_PILL_MODEL,
    order: 0,
    info: { firmware: null, deviceType: null, payloadVersion: null },
    live: {
      lastHeardAt: NOW - 60_000,
      lastReadingAt: latest?.ts ?? null,
      firstReadingAt: NOW - 30 * DAY,
      online: true,
      rssi: -60,
      intervalSec: 900,
      latest,
      computedVelocity: null,
      caught: null,
    },
    brew: null,
    ...rest,
  };
}

const DEVICES: Pill[] = [
  pill({ brew: brew() }),
  pill({
    id: 'p2',
    name: 'A pill with a really rather long name that goes on',
    color: '#60a5fa',
    brew: brew({ id: 'b2', pillId: 'p2', name: 'Czech Pils with a long brew name too', targetFg: null }),
  }),
  pill({ id: 'p3', name: 'Spare pill', color: '#22d3ee', latest: reading({ gravity: 1.2, pillGravity: 1.2, plausible: false }) }),
  pill({
    id: 'p4',
    kind: 'thermometer',
    name: 'Brew fridge',
    color: '#f472b6',
    latest: reading({ gravity: null, velocity: null, battery: null, tilt: null, temperature: 3.4 }),
  }),
  pill({
    id: 'p5',
    name: 'Offline pill',
    color: '#34d399',
    latest: null,
    live: { ...pill().live, online: false, latest: null, lastReadingAt: null },
  }),
];

function fakeHistory(id: string, from: number, to: number): History {
  const ts: number[] = [];
  const gravity: (number | null)[] = [];
  const temperature: (number | null)[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = from + ((to - from) * i) / 120;
    ts.push(t);
    gravity.push(id === 'p4' ? null : 1.011 + 0.042 / (1 + Math.exp((i - 40) / 8)));
    temperature.push(19 + Math.sin(i / 6));
  }
  const none = ts.map(() => null);
  return {
    pillId: id,
    from,
    to,
    bucketMs: 0,
    ts,
    gravity,
    temperature,
    velocity: none,
    battery: none,
    rssi: none,
    tilt: none,
    implausible: none,
  };
}

function service(devices: Pill[] = DEVICES, units = { gravity: 'sg' as const, temperature: 'C' as const }) {
  const deps = {
    store: { history: (id: string, from: number, to: number) => fakeHistory(id, from, to) },
    pills: { list: () => devices, get: (id: string) => devices.find((p) => p.id === id) ?? null, gapMs: () => 3_600_000 },
    settings: { units: () => units, hub: () => ({ ...DEFAULT_HUB_SETTINGS, name: 'Garage brewery', units }) },
    config: { rawRetentionDays: 0 },
  };
  return new ScreenService(deps as unknown as ConstructorParameters<typeof ScreenService>[0], () => assets);
}

const svgOf = (query: Record<string, string>, pillId: string | null = null, devices?: Pill[]) => {
  const s = service(devices);
  return s.svg(pillId, s.options(query), NOW).svg;
};

// ---------- Reading the SVG back ----------

const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);

interface DrawnText {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Every line of text with the box it takes up, measured the way the renderer measures it. */
function texts(svg: string): DrawnText[] {
  const out: DrawnText[] = [];
  const re =
    /<text x="([-\d.]+)" y="([-\d.]+)" font-family="Inter" font-size="([\d.]+)" font-weight="(\d+)"(?: letter-spacing="([-\d.]+)")?(?: text-anchor="(\w+)")?[^>]*>(.*?)<\/text>/g;
  for (const m of svg.matchAll(re)) {
    const [, x, y, size, weight, spacing, anchor, inner] = m;
    const base = { size: Number(size), weight: Number(weight) as FontWeight, spacing: spacing ? Number(spacing) / Number(size) : 0 };
    let width = 0;
    let all = '';
    for (const part of inner!.matchAll(/<tspan([^>]*)>(.*?)<\/tspan>|([^<]+)/g)) {
      const attrs = part[1] ?? '';
      const content = unescape(part[2] ?? part[3] ?? '');
      const own = (name: string) => /([-\d.]+)/.exec(new RegExp(`${name}="([-\\d.]+)"`).exec(attrs)?.[1] ?? '')?.[1];
      const segSize = own('font-size') ? Number(own('font-size')) : base.size;
      const segWeight = own('font-weight') ? (Number(own('font-weight')) as FontWeight) : base.weight;
      const segSpacing = own('letter-spacing') !== undefined ? Number(own('letter-spacing')) / segSize : base.spacing;
      width += measure.width(content, { size: segSize, weight: segWeight, spacing: segSpacing }) + Number(own('dx') ?? 0);
      all += content;
    }
    const left = anchor === 'end' ? Number(x) - width : anchor === 'middle' ? Number(x) - width / 2 : Number(x);
    out.push({ text: all, left, right: left + width, top: Number(y) - base.size * 0.75, bottom: Number(y) + base.size * 0.22 });
  }
  return out;
}

const words = (svg: string) => texts(svg).map((t) => t.text);

const PRESETS: Record<string, ScreenItem[]> = {
  readings: ['name', 'status', 'gravity', 'temperature'],
  big: ['gravity', 'temperature'],
  brew: ['name', 'status', 'gravity', 'temperature', 'brew', 'progress'],
  graph: ['name', 'status', 'gravity', 'temperature', 'brew', 'chart'],
  everything: [...SCREEN_ITEMS],
};

// ---------- Tests ----------

describe('screen image colours', () => {
  const css = (name: string) => readFileSync(new URL(`../../web/app/${name}`, import.meta.url), 'utf8');
  const styles = css('styles.css');
  const palettes = css('palettes.css');
  const block = (source: string, selector: string) => {
    const start = source.indexOf(`${selector} {`);
    return start < 0 ? '' : source.slice(start, source.indexOf('}', start));
  };
  const cssVar = (b: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(b)?.[1]?.trim();

  it("match the app's CSS for every palette and theme", () => {
    for (const palette of SCREEN_PALETTES)
      for (const theme of ['dark', 'light'] as const) {
        const base = block(styles, theme === 'dark' ? ':root' : ":root[data-theme='light']");
        const own = palette === 'violet' ? '' : block(palettes, `:root[data-palette='${palette}'][data-theme='${theme}']`);
        for (const [key, name] of Object.entries(CSS_VARS)) {
          const expected = cssVar(own, name) ?? cssVar(base, name) ?? cssVar(block(styles, ':root'), name);
          expect(SCREEN_COLORS[palette][theme][key as keyof typeof CSS_VARS], `${palette} ${theme} --${name}`).toBe(expected);
        }
      }
  });

  it('reads CSS colours and gradients', () => {
    expect(parseColor('#a78bfa')).toEqual({ r: 167, g: 139, b: 250, a: 1 });
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgba(24, 21, 58, 0.66)')).toEqual({ r: 24, g: 21, b: 58, a: 0.66 });
    expect(gradientStops('linear-gradient(135deg, #c4b5fd 0%, #8b5cf6 38%, #3b82f6 100%)')).toEqual([
      { color: '#c4b5fd', offset: 0 },
      { color: '#8b5cf6', offset: 0.38 },
      { color: '#3b82f6', offset: 1 },
    ]);
    expect(gradientStops('linear-gradient(135deg, rgba(139, 92, 246, 0.22), rgba(59, 130, 246, 0.18))').map((s) => s.offset)).toEqual([
      0, 1,
    ]);
  });
});

describe('screen image text', () => {
  it('is measured from the fonts, and cut short with an ellipsis to fit', () => {
    const style = { size: 20, weight: 700 as const };
    const w = measure.width('Hazy IPA', style);
    expect(w).toBeGreaterThan(70);
    expect(w).toBeLessThan(110);
    expect(measure.width('Hazy IPA', { ...style, weight: 400 })).toBeLessThan(w);
    expect(measure.width('Hazy IPA', { ...style, spacing: 0.1 })).toBeCloseTo(w + 8 * 2, 5);
    expect(measure.fit('Hazy IPA', 1000, style)).toBe('Hazy IPA');
    const cut = measure.fit('A pill with a long name', 80, style);
    expect(cut.endsWith('…')).toBe(true);
    expect(measure.width(cut, style)).toBeLessThanOrEqual(80);
    expect(measure.fit('Hazy IPA', 2, style)).toBe('');
  });
});

describe('screen image layout', () => {
  const SIZES: [number, number][] = [
    [240, 240],
    [320, 240],
    [296, 128],
    [480, 320],
    [800, 480],
    [480, 800],
    [1920, 1080],
    [64, 64],
    [2048, 200],
  ];

  it('keeps every word inside the picture at any size, with anything shown', () => {
    for (const [w, h] of SIZES)
      for (const [preset, items] of Object.entries(PRESETS))
        for (const pillId of [null, 'p1', 'p2', 'p4']) {
          const svg = svgOf({ w: String(w), h: String(h), show: items.join(',') }, pillId);
          expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"`)).toBe(true);
          const drawn = texts(svg);
          expect(drawn.length, `${w}×${h} ${preset} ${pillId ?? 'all'}`).toBeGreaterThan(0);
          for (const t of drawn) {
            const where = `${w}×${h} ${preset} ${pillId ?? 'all'}: "${t.text}"`;
            expect(t.left, where).toBeGreaterThanOrEqual(-0.5);
            expect(t.right, where).toBeLessThanOrEqual(w + 0.5);
            expect(t.top, where).toBeGreaterThanOrEqual(-0.5);
            expect(t.bottom, where).toBeLessThanOrEqual(h + 0.5);
          }
        }
  });

  it('shows a whole brew on a big screen', () => {
    const svg = svgOf({ w: '800', h: '480', show: PRESETS.everything!.join(',') }, 'p1');
    const shown = words(svg);
    expect(shown).toEqual(
      expect.arrayContaining([
        'Garage brewery',
        'Hazy IPA',
        'Online · 2 min ago',
        'GRAVITY',
        '1.0111SG',
        '19.2 °C',
        'Hazy IPA #4',
        'Day 9 · 5.5% ABV',
        'OG 1.0531',
        'FG 1.0120',
        'ABV',
        '5.5%',
        'BATTERY',
        '83%',
        'Excellent',
      ]),
    );
    // The chart, with the gravity it starts and ends at.
    expect(shown).toEqual(expect.arrayContaining(['1.053', '1.011']));
    expect(svg).toContain('stroke="#a78bfa"');
  });

  it('leaves out what does not fit at a readable size, least important first', () => {
    const tiny = words(svgOf({ w: '240', h: '240', show: PRESETS.everything!.join(',') }));
    expect(tiny).not.toContain('BATTERY');
    expect(tiny.some((t) => t.startsWith('Hazy IPA'))).toBe(true);
    expect(tiny).toContain('1.0111SG');
    // Just the numbers on a GeekMagic screen: as big as they go.
    const big = texts(svgOf({ w: '240', h: '240', show: 'gravity,temperature' }, 'p1'));
    const gravity = big.find((t) => t.text === '1.0111SG')!;
    expect(gravity.right - gravity.left).toBeGreaterThan(160);
  });

  it('puts many devices on a short screen in rows', () => {
    const svg = svgOf({ w: '296', h: '128', show: 'name,gravity,temperature' });
    const names = texts(svg).filter((t) => ['Hazy IPA', 'Spare pill', 'Brew fridge', 'Offline pill'].includes(t.text));
    expect(names).toHaveLength(4);
    // One above the other, lined up on the left.
    expect(new Set(names.map((t) => Math.round(t.left))).size).toBe(1);
  });

  it('says so when there is nothing to show', () => {
    expect(words(svgOf({}, null, []))).toContain('No pills yet');
    expect(words(svgOf({ brewing: '1' }, null, [pill({ id: 'x' })]))).toContain('No brews on the go');
    expect(words(svgOf({}, 'gone'))).toContain('Pill not found');
  });

  it('leaves out archived pills and, when asked, those without a brew', () => {
    const devices = [pill({ brew: brew() }), pill({ id: 'p9', name: 'Old pill', archived: true }), pill({ id: 'p8', name: 'Idle pill' })];
    const all = words(svgOf({ show: 'name,gravity' }, null, devices));
    expect(all).toContain('Idle pill');
    expect(all).not.toContain('Old pill');
    expect(words(svgOf({ show: 'name,gravity', brewing: '1' }, null, devices))).not.toContain('Idle pill');
    // An archived pill's own picture still works.
    expect(words(svgOf({ show: 'name,gravity' }, 'p9', devices))).toContain('Old pill');
  });

  it('uses the units, language, time zone and colours asked for', () => {
    const plato = words(svgOf({ show: 'gravity,temperature', gravity: 'plato', temp: 'F' }, 'p1'));
    expect(plato).toContain('2.8°P');
    expect(plato).toContain('66.6 °F');
    const de = svgOf({ show: 'header,name,status,gravity,temperature,brew,stats', lang: 'de-DE', tz: 'Europe/Berlin' }, 'p1');
    expect(words(de)).toEqual(expect.arrayContaining(['1,0111SG', '19,2 °C', 'DICHTE', 'Tag 9 · 5,5% ABV', 'AKKU', '13:00']));
    expect(words(svgOf({ show: 'header', tz: 'America/New_York', lang: 'en-US' }, 'p1'))).toContain('08:00 AM');
    expect(svgOf({ theme: 'dark', palette: 'violet' })).toContain(`<rect width="800" height="480" fill="#08071c"/>`);
    expect(svgOf({ theme: 'light', palette: 'ocean' })).toContain(`<rect width="800" height="480" fill="#eff9fc"/>`);
  });

  it('escapes names', () => {
    const svg = svgOf({ w: '800', h: '480', show: 'name,gravity' }, 'p1', [pill({ name: 'Ale <&> "Stout"' })]);
    expect(svg).toContain('Ale &lt;&amp;&gt; &quot;Stout&quot;');
    expect(svg).not.toContain('<&>');
  });
});

describe('screen image files', () => {
  it('are PNG, baseline JPEG or BMP of the size asked for', async () => {
    const s = service();
    const png = await s.image('p1', 'png', { w: '240', h: '240' }, NOW);
    expect(png).toMatchObject({ status: 200, type: 'image/png' });
    expect(png.body.subarray(1, 4).toString()).toBe('PNG');
    expect([png.body.readUInt32BE(16), png.body.readUInt32BE(20)]).toEqual([240, 240]);

    const jpg = await s.image(null, 'jpg', { w: '320', h: '200' }, NOW);
    expect(jpg.type).toBe('image/jpeg');
    expect([...jpg.body.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    // Baseline (SOF0), which small decoders such as an ESP8266's need.
    expect(jpg.body.includes(Buffer.from([0xff, 0xc0]))).toBe(true);
    const decoded = jpeg.decode(jpg.body);
    expect([decoded.width, decoded.height]).toEqual([320, 200]);

    const bmp = await s.image(null, 'bmp', { w: '101', h: '64' }, NOW);
    expect(bmp.type).toBe('image/bmp');
    expect(bmp.body.subarray(0, 2).toString()).toBe('BM');
    expect([bmp.body.readInt32LE(18), bmp.body.readInt32LE(22), bmp.body.readUInt16LE(28)]).toEqual([101, 64, 24]);
    // Rows are padded to four bytes.
    expect(bmp.body.length).toBe(54 + 304 * 64);

    expect((await s.image('gone', 'png', {}, NOW)).status).toBe(404);
  });

  it('draws the same address once in a while, however often it is asked for', async () => {
    const s = service();
    const a = s.image('p1', 'png', { w: '240', h: '240' }, NOW);
    expect(s.image('p1', 'png', { w: '240', h: '240' }, NOW + 1000)).toBe(a);
    expect(s.image('p1', 'png', { w: '240', h: '241' }, NOW + 1000)).not.toBe(a);
    expect(s.image('p1', 'png', { w: '240', h: '240' }, NOW + 20_000)).not.toBe(a);
    await a;
  });

  it('writes BMP bottom row first, in blue-green-red', () => {
    // 1×2: red on top, blue below.
    const bmp = encodeBmp(1, 2, new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]));
    expect([...bmp.subarray(54, 57)]).toEqual([255, 0, 0]);
    expect([...bmp.subarray(58, 61)]).toEqual([0, 0, 255]);
  });
});

// ---------- Through the API ----------

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

async function setup() {
  const t = tempStore();
  const config = parseConfig({ dataDir: t.dir, webDir: `${t.dir}/no-web` }, t.dir, t.dir);
  const clock = new ClockGuard({ syncFile: null, maxWaitMs: 0 });
  const pills = new PillService(t.store, clock, silent);
  const brews = new BrewService(t.store, pills, silent);
  pills.brewOf = (id) => brews.activeFor(id);
  const webhooks = new WebhookService(
    t.store,
    { pills, brews, clockTrusted: () => true, version: 't', fetch: (async () => new Response('ok')) as typeof fetch },
    silent,
  );
  const push = {
    publicKey: 'k',
    send: async () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  } as unknown as PushService;
  const settings = new Settings(t.store);
  const alerts = new AlertService(t.store, { pills, brews, units: () => settings.units() }, push, silent);
  const app = await buildServer({
    config,
    store: t.store,
    pills,
    brews,
    webhooks,
    alerts,
    push,
    maintenance: new Maintenance(t.store, silent, { backupDir: '', backupTime: '03:00', keep: 1, rawRetentionDays: 0 }),
    scanner: new UnavailableScanner('test'),
    clock,
    settings,
    mqtt: new MqttService({ pills, brews, settings, version: 't' }, silent),
    channels: new ChannelService(t.store, silent),
    updates: new UpdateService('t', settings, silent),
    system: new SystemService(config, t.store, silent),
    tokens: new TokenService(t.store),
    logs: new LogBuffer(),
    version: 't',
    startedAt: Date.now(),
  });
  cleanup = () => {
    void app.close();
    t.cleanup();
  };
  return { app, pills, brews };
}

describe('screen image API', () => {
  it('gives anyone on the network a fresh picture of every pill, or of one', async () => {
    const { app, pills, brews } = await setup();
    const p = pills.adopt('F0:0D:5E:ED:00:03', { name: 'Hazy IPA' });
    brews.start(p.id, { name: 'Hazy IPA #4' });

    const all = await app.inject({ url: '/api/image.png?w=320&h=240&theme=light&palette=hops&show=header,name,gravity,chart' });
    expect(all.statusCode).toBe(200);
    expect(all.headers['content-type']).toBe('image/png');
    expect(all.headers['cache-control']).toBe('no-store');
    expect(all.rawPayload.readUInt32BE(16)).toBe(320);

    const one = await app.inject({ url: `/api/pills/${p.id}/image.jpg?w=240&h=240` });
    expect(one.statusCode).toBe(200);
    expect(one.headers['content-type']).toBe('image/jpeg');
    expect(jpeg.decode(one.rawPayload).width).toBe(240);

    const bmp = await app.inject({ url: `/api/pills/${p.id}/image.BMP` });
    expect(bmp.headers['content-type']).toBe('image/bmp');
  });

  it('says what went wrong with a bad address', async () => {
    const { app } = await setup();
    const missing = await app.inject({ url: '/api/pills/nope/image.png?w=240&h=240' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toBe('image/png');
    const gif = await app.inject({ url: '/api/image.gif' });
    expect(gif.statusCode).toBe(404);
    expect(gif.json().error).toMatch(/png, \.jpg or \.bmp/);
  });
});
