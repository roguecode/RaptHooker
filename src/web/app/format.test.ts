import { afterEach, describe, expect, it } from 'vitest';
import { setCatalog } from './i18n';
import { bytes, days, duration, fixed, signalLevel, signalQuality, timeAgo, timeUntil } from './format';

afterEach(() => setCatalog('en', {}));

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const now = Date.UTC(2026, 5, 10, 12);

describe('format', () => {
  it('says how long ago, in English by default', () => {
    expect(timeAgo(null)).toBe('never');
    expect(timeAgo(now - 3 * S, now)).toBe('just now');
    expect(timeAgo(now - 30 * S, now)).toBe('30 s ago');
    expect(timeAgo(now - 5 * M, now)).toBe('5 min ago');
    expect(timeAgo(now - 90 * M, now)).toBe('1.5 h ago');
    expect(timeAgo(now - 3 * H, now)).toBe('3 h ago');
    expect(timeAgo(now - D, now)).toBe('1 day ago');
    expect(timeAgo(now - 2.5 * D, now)).toBe('2.5 days ago');
    expect(timeAgo(now - 12 * D, now)).toBe('12 days ago');
  });

  it('says how long until, and how long something took', () => {
    expect(timeUntil(now + 2 * S, now)).toBe('any moment');
    expect(timeUntil(now + 40 * S, now)).toBe('in 40 s');
    expect(timeUntil(now + 5 * M, now)).toBe('in 5 min');
    expect(timeUntil(now + 90 * M, now)).toBe('in 1.5 h');
    expect(duration(45 * S)).toBe('45 s');
    expect(duration(5 * M)).toBe('5 min');
    expect(duration(2 * H + 5 * M)).toBe('2 h 5 min');
    expect(duration(3 * D + 4 * H)).toBe('3 days 4 h');
    expect(days(5 * H)).toBe('5 h');
    expect(days(7 * D)).toBe('7.0 days');
  });

  it('formats numbers without a "-0"', () => {
    expect(fixed(-0.01, 1)).toBe('0.0');
    expect(fixed(1.048, 4)).toBe('1.0480');
    expect(bytes(1536)).toBe('1.5 KB');
  });

  it('says how good a Bluetooth signal is', () => {
    const rate = (rssi: number | null) => {
      const q = signalQuality(rssi);
      return q && [q.level, q.label];
    };
    expect(rate(null)).toBeNull();
    expect(signalQuality(Number.NaN)).toBeNull();
    expect(rate(-40)).toEqual([4, 'Excellent']);
    expect(rate(-65)).toEqual([4, 'Excellent']);
    expect(rate(-66)).toEqual([3, 'Good']);
    expect(rate(-75)).toEqual([3, 'Good']);
    expect(rate(-80)).toEqual([2, 'OK']);
    expect(rate(-85)).toEqual([2, 'OK']);
    expect(rate(-90)).toEqual([1, 'Weak']);
    expect(rate(-94)).toEqual([0, 'Very weak']);
    expect(signalQuality(-94)?.quality).toBe('very-weak');
    expect(signalLevel(-70)).toBe(3);
    expect(signalLevel(undefined)).toBe(0);

    setCatalog('de', { 'signal::Weak': 'Schwach' });
    expect(signalQuality(-90)?.label).toBe('Schwach');
  });

  it('uses the language in use for words and numbers', () => {
    setCatalog('de', {
      '{n} days': '{n} Tage',
      '{n} min ago': 'vor {n} Min.',
      '{count} day ago|{count} days ago': { one: 'vor {count} Tag', other: 'vor {count} Tagen' },
    });
    expect(days(7.5 * D)).toBe('7,5 Tage');
    expect(timeAgo(now - 5 * M, now)).toBe('vor 5 Min.');
    expect(timeAgo(now - D, now)).toBe('vor 1 Tag');
    expect(timeAgo(now - 2.5 * D, now)).toBe('vor 2,5 Tagen');
    expect(fixed(1.048, 3)).toBe('1,048');
    expect(timeAgo(now - 30 * S, now)).toBe('30 s ago');
  });
});
