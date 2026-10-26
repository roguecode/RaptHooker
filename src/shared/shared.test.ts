import { describe, expect, it } from 'vitest';
import { PRESETS } from './presets.js';
import { renderRequest, renderTemplate } from './template.js';
import { buildContext, sampleReading, VARIABLES } from './variables.js';
import { abv, attenuation, platoToSg, sgToPlato } from './units.js';
import { raptIdFromAddress } from './format.js';

const ctx = buildContext({
  pill: {
    id: 'p1',
    name: 'Hazy "IPA"',
    address: '08:B6:1F:00:00:66',
    raptId: '08:B6:1F:00:00:64',
    info: { firmware: 'fw', deviceType: 'PillG1', payloadVersion: 2 },
  },
  reading: sampleReading(Date.UTC(2026, 9, 1)),
  brew: null,
  gravityUnit: 'sg',
  temperatureUnit: 'C',
  intervalSec: 900,
  now: Date.UTC(2026, 9, 1),
  appVersion: '1.0.0',
});

describe('templates', () => {
  it('escapes strings for JSON and leaves numbers bare', () => {
    const r = renderTemplate('{"name": "{{name}}", "g": {{gravity}}, "v": {{brew_og}}}', ctx, 'json');
    expect(JSON.parse(r.text)).toEqual({ name: 'Hazy "IPA"', g: 1.0213, v: null });
  });

  it('uses fallbacks for missing values', () => {
    expect(renderTemplate('{{brew_og|0}}', ctx, 'json').text).toBe('0');
    expect(renderTemplate('[{{brew_name|none yet}}]', ctx, 'text').text).toBe('[none yet]');
  });

  it('url-encodes values in URLs and reports unknown variables', () => {
    const r = renderTemplate('https://x/{{name}}?a={{nope}}', ctx, 'url');
    expect(r.text).toBe('https://x/Hazy%20%22IPA%22?a=');
    expect(r.unknown).toEqual(['nope']);
  });

  it("treats names of JavaScript's built-in object methods as unknown variables", () => {
    for (const mode of ['json', 'url', 'header', 'text', 'form'] as const) {
      const r = renderTemplate('{{constructor}}|{{toString}}|{{__proto__}}|{{hasOwnProperty}}', ctx, mode);
      expect(r.unknown.sort()).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
      expect(r.text).not.toContain('function');
    }
  });

  it('every documented variable is in the context', () => {
    for (const v of VARIABLES) expect(Object.hasOwn(ctx, v.key), v.key).toBe(true);
    expect(Object.keys(ctx).sort()).toEqual(VARIABLES.map((v) => v.key).sort());
  });

  it('chip_id is the last three bytes of the address', () => {
    expect(ctx.chip_id).toBe(0x66);
  });

  it('gives null for everything a thermometer has no reading of', () => {
    const reading = {
      ...sampleReading(Date.UTC(2026, 9, 1)),
      gravity: null,
      pillGravity: null,
      velocity: null,
      battery: null,
      tilt: null,
      x: null,
      y: null,
      z: null,
    };
    const t = buildContext({
      pill: {
        id: 't1',
        name: 'Fridge',
        address: 'D0:26:25:B4:48:95',
        raptId: 'D0:26:25:B4:48:95',
        info: { firmware: null, deviceType: null, payloadVersion: null },
        kind: 'thermometer',
      },
      reading,
      brew: null,
      gravityUnit: 'plato',
      temperatureUnit: 'F',
      intervalSec: 900,
      now: Date.UTC(2026, 9, 1),
      appVersion: '1.0.0',
    });
    expect(t).toMatchObject({ device: 'thermometer', temperature: 67.28, temperature_c: 19.6, rssi: -61 });
    for (const key of [
      'gravity',
      'gravity_sg',
      'gravity_plato',
      'gravity_points',
      'pill_gravity_sg',
      'battery',
      'tilt',
      'accel_x',
      'accel_z',
    ])
      expect(t[key], key).toBeNull();
    expect(JSON.parse(renderTemplate('{"g": {{gravity}}, "t": {{temperature}}}', t, 'json').text)).toEqual({ g: null, t: 67.28 });
    expect(ctx.device).toBe('pill');
  });
});

describe('presets', () => {
  for (const preset of PRESETS) {
    it(`${preset.name} renders a valid request`, () => {
      const filled = {
        ...preset,
        url: preset.url.replace(/<[A-Z_ ]+>/g, 'abc'),
        headers: preset.headers.map((h) => ({ ...h, value: h.value.replace(/<[A-Z_ ]+>/g, 'abc') })),
        body: preset.body.replace(/<[A-Z_ ]+>/g, 'abc'),
      };
      const r = renderRequest(filled, ctx);
      expect(
        r.warnings.filter((w) => !w.includes('http')),
        r.body ?? '',
      ).toEqual([]);
      if (preset.id !== 'custom') expect(r.url).toMatch(/^https?:\/\//);
      if (r.body) expect(() => JSON.parse(r.body!)).not.toThrow();
    });
  }

  it('flags unfilled placeholders', () => {
    const r = renderRequest(
      PRESETS.find((p) => p.id === 'brewfather')!,
      ctx,
    );
    expect(r.warnings.some((w) => w.includes('PLACEHOLDERS'))).toBe(true);
  });

  it('refuses credentials in the URL', () => {
    const custom = { ...PRESETS.find((p) => p.id === 'custom')!, url: 'https://user:secret@example.com/hook' };
    expect(renderRequest(custom, ctx).warnings.some((w) => w.includes('Authorization header'))).toBe(true);
  });

  it('Brewfather gets SG with unit G', () => {
    const bf = PRESETS.find((p) => p.id === 'brewfather')!;
    const body = JSON.parse(renderRequest(bf, ctx).body!);
    expect(body).toMatchObject({ name: 'Hazy "IPA"', gravity: 1.0213, gravity_unit: 'G', temp: 19.6, temp_unit: 'C' });
  });
});

describe('units', () => {
  it('converts SG and Plato both ways', () => {
    expect(sgToPlato(1.05)).toBeCloseTo(12.39, 1);
    expect(platoToSg(12.39)).toBeCloseTo(1.05, 3);
  });

  it('works out ABV and attenuation', () => {
    expect(abv(1.05, 1.01)).toBeCloseTo(5.3, 1);
    expect(attenuation(1.05, 1.01)).toBeCloseTo(80, 5);
  });

  it('derives the RAPT id from the Bluetooth address', () => {
    expect(raptIdFromAddress('aa:bb:cc:dd:ee:66')).toBe('AA:BB:CC:DD:EE:64');
    expect(raptIdFromAddress('AA:BB:CC:DD:EE:01')).toBe('AA:BB:CC:DD:EE:FF');
  });
});
