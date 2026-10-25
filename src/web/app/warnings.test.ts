import { describe, expect, it } from 'vitest';
import type { HubWarning } from '@rapthooker/shared';
import { bannerWarnings, parseDismissed, pruneDismissed, serializeDismissed, warningKey } from './warnings';

const disk: HubWarning = { id: 'disk', level: 'warn', message: 'The SD card is 92% full' };
const ble: HubWarning = { id: 'ble', level: 'error', message: 'Bluetooth adapter not found' };
const info: HubWarning = { id: 'tip', level: 'info', message: 'Backups go to a USB stick too' };

describe('hub warnings', () => {
  it('shows warn and error levels that have not been dismissed', () => {
    expect(bannerWarnings([disk, ble, info], [])).toEqual([disk, ble]);
    expect(bannerWarnings([disk, ble], [warningKey(disk)])).toEqual([ble]);
  });

  it('shows a dismissed warning again when its message changes', () => {
    const fuller = { ...disk, message: 'The SD card is 97% full' };
    expect(bannerWarnings([fuller], [warningKey(disk)])).toEqual([fuller]);
  });

  it('forgets dismissals of warnings that have gone', () => {
    expect(pruneDismissed([warningKey(disk), warningKey(ble)], [ble])).toEqual([warningKey(ble)]);
  });

  it('reads saved dismissals defensively and keeps the list short', () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed('{oops')).toEqual([]);
    expect(parseDismissed('{"a":1}')).toEqual([]);
    expect(parseDismissed('["a", 2, "b"]')).toEqual(['a', 'b']);
    const many = Array.from({ length: 80 }, (_, i) => `w${i}`);
    expect(parseDismissed(serializeDismissed(many))).toHaveLength(50);
    expect(parseDismissed(serializeDismissed(many)).at(-1)).toBe('w79');
  });
});
