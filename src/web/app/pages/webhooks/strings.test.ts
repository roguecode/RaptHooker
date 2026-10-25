import { describe, expect, it } from 'vitest';
import { BATCH_VARIABLES, PRESETS, UNTESTED_PRESET_NOTE, VARIABLES } from '@rapthooker/shared';
import { SHARED_STRINGS, UNTRANSLATED, warningText } from './strings';

describe('webhook strings for translation', () => {
  it('lists every preset description, setup step and note, and every variable description', () => {
    const shown = [
      UNTESTED_PRESET_NOTE,
      ...PRESETS.flatMap((p) => [p.tagline, ...p.setup, ...p.notes]),
      ...VARIABLES.flatMap((v) => [v.group, v.description]),
      ...BATCH_VARIABLES.map((v) => v.description),
    ].filter((s) => !UNTRANSLATED.has(s));
    const listed = new Set(SHARED_STRINGS);
    expect([...new Set(shown)].filter((s) => !listed.has(s))).toEqual([]);
  });

  it('keeps the details in preview warnings', () => {
    expect(warningText('Unknown variable {{gravityy}}')).toBe('Unknown variable {{gravityy}}');
    expect(warningText("The body isn't valid JSON: Unexpected token")).toBe("The body isn't valid JSON: Unexpected token");
    expect(warningText('The URL must start with http:// or https://')).toBe('The URL must start with http:// or https://');
  });
});
