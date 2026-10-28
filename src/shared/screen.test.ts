import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCREEN_ITEMS,
  defaultScreenOptions,
  parseScreenQuery,
  SCREEN_MAX_SIZE,
  SCREEN_MIN_SIZE,
  screenLang,
  screenPath,
  screenQuery,
  screenTimeZone,
  type ScreenOptions,
} from './screen.js';

const defaults = defaultScreenOptions({ gravity: 'sg', temperature: 'C' });
const parse = (query: Record<string, unknown>) => parseScreenQuery(query, defaults);

describe('screen image options', () => {
  it('fills in what the address leaves out, with the hub units', () => {
    expect(parse({})).toEqual(defaults);
    expect(defaults).toMatchObject({ width: 800, height: 480, theme: 'dark', palette: 'violet', lang: 'en', tz: null, brewing: false });
    expect(defaults.show).toEqual(DEFAULT_SCREEN_ITEMS);
    expect(parseScreenQuery({}, defaultScreenOptions({ gravity: 'plato', temperature: 'F' }))).toMatchObject({
      gravity: 'plato',
      temperature: 'F',
    });
  });

  it('reads every option', () => {
    const o = parse({
      w: '240',
      h: '240',
      theme: 'light',
      palette: 'ocean',
      show: 'gravity,chart,header',
      range: '7d',
      gravity: 'plato',
      temp: 'F',
      lang: 'de-AT',
      tz: 'Europe/Berlin',
      brewing: '1',
    });
    expect(o).toEqual({
      width: 240,
      height: 240,
      theme: 'light',
      palette: 'ocean',
      show: ['header', 'gravity', 'chart'],
      range: '7d',
      gravity: 'plato',
      temperature: 'F',
      lang: 'de-AT',
      tz: 'Europe/Berlin',
      brewing: true,
    });
  });

  it('keeps sizes within limits and ignores what it does not understand, so a screen always gets a picture', () => {
    expect(parse({ w: '10', h: '99999' })).toMatchObject({ width: SCREEN_MIN_SIZE, height: SCREEN_MAX_SIZE });
    expect(parse({ w: 'wide', h: '' })).toMatchObject({ width: defaults.width, height: defaults.height });
    expect(parse({ w: '320.6' }).width).toBe(321);
    expect(parse({ theme: 'neon', palette: 'plaid', range: 'forever', gravity: 'brix', temp: 'K' })).toMatchObject({
      theme: 'dark',
      palette: 'violet',
      range: 'brew',
      gravity: 'sg',
      temperature: 'C',
    });
    expect(parse({ theme: 'LIGHT', temp: 'f' })).toMatchObject({ theme: 'light', temperature: 'F' });
    expect(parse({ show: 'gravity,sparkles, TEMPERATURE' }).show).toEqual(['gravity', 'temperature']);
    expect(parse({ show: ['name', 'gravity,chart'] }).show).toEqual(['name', 'gravity', 'chart']);
    expect(parse({ show: '' }).show).toEqual([]);
    expect(parse({ brewing: '0' }).brewing).toBe(false);
  });

  it('only takes languages and time zones that exist', () => {
    expect(screenLang('pt-br')).toBe('pt-BR');
    expect(screenLang('en-GB')).toBe('en-GB');
    expect(screenLang('<script>')).toBe('en');
    expect(screenLang(undefined)).toBe('en');
    expect(screenTimeZone('America/New_York')).toBe('America/New_York');
    expect(screenTimeZone('Mars/Olympus_Mons')).toBeNull();
    expect(screenTimeZone('../../etc')).toBeNull();
    expect(parse({ tz: 'Nowhere/Land' }).tz).toBeNull();
  });

  it('writes every option into the address, readably, and reads it back the same', () => {
    const o: ScreenOptions = {
      ...defaults,
      width: 296,
      height: 128,
      theme: 'light',
      palette: 'graphite',
      show: ['chart', 'name', 'gravity'],
      range: '3d',
      lang: 'nl',
      tz: 'Europe/Amsterdam',
      brewing: true,
    };
    const query = screenQuery(o, { allDevices: true });
    expect(query).toBe(
      'w=296&h=128&theme=light&palette=graphite&show=name,gravity,chart&range=3d&gravity=sg&temp=C&lang=nl&tz=Europe/Amsterdam&brewing=1',
    );
    const fields = Object.fromEntries(query.split('&').map((p) => p.split('=').map(decodeURIComponent)));
    expect(parse(fields)).toEqual({ ...o, show: ['name', 'gravity', 'chart'] });
    // The range only matters with a chart, and a single device's picture has no brewing filter.
    const single = screenQuery({ ...o, show: ['gravity'] }, { allDevices: false });
    expect(single).not.toContain('range=');
    expect(single).not.toContain('brewing');
  });

  it('has an address for every device and for each one', () => {
    expect(screenPath('png')).toBe('/api/image.png');
    expect(screenPath('jpg', 'f00d5eed0003')).toBe('/api/pills/f00d5eed0003/image.jpg');
    expect(screenPath('bmp', 'a/b')).toBe('/api/pills/a%2Fb/image.bmp');
  });
});
