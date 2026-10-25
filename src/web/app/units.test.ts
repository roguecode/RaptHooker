import { describe, expect, it } from 'vitest';
import { effectiveUnits, parseUnitChoice } from './units';

describe('units', () => {
  const hub = { gravity: 'plato', temperature: 'F' } as const;

  it("follows the hub for anything this browser hasn't picked", () => {
    expect(effectiveUnits({}, hub)).toEqual(hub);
    expect(effectiveUnits({ gravity: 'sg' }, hub)).toEqual({ gravity: 'sg', temperature: 'F' });
    expect(effectiveUnits({ gravity: 'sg', temperature: 'C' }, hub)).toEqual({ gravity: 'sg', temperature: 'C' });
  });

  it('reads saved choices (including from older versions, which saved both) and ignores junk', () => {
    expect(parseUnitChoice(null)).toEqual({});
    expect(parseUnitChoice('{}')).toEqual({});
    expect(parseUnitChoice('{"temperature":"C","gravity":"sg"}')).toEqual({ temperature: 'C', gravity: 'sg' });
    expect(parseUnitChoice('{"temperature":"K","gravity":"brix"}')).toEqual({});
    expect(parseUnitChoice('null')).toEqual({});
    expect(parseUnitChoice('nope')).toEqual({});
  });
});
