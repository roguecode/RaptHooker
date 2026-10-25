import { afterEach, describe, expect, it } from 'vitest';
import {
  checkInput,
  hubSettingsSchema,
  mqttSettingsSchema,
  pillPatchSchema,
  startBrewSchema,
  webhookInputSchema,
} from '@rapthooker/shared';
import { setCatalog } from './i18n';
import { checkForm, gravityError } from './validation';

afterEach(() => setCatalog('en', {}));

const hub = { name: 'Hub', units: { temperature: 'C', gravity: 'sg' }, abvFormula: 'standard', updateCheck: true };
const mqtt = {
  enabled: true,
  url: 'nope',
  username: '',
  password: '',
  topic: 'a b',
  discovery: true,
  discoveryPrefix: '',
  retain: false,
  skipImplausible: true,
};

const CASES: [Parameters<typeof checkInput>[0], unknown][] = [
  [hubSettingsSchema, { ...hub, name: '' }],
  [hubSettingsSchema, { ...hub, name: 'x'.repeat(41), units: { temperature: 'K', gravity: 'sg' } }],
  [
    webhookInputSchema,
    { name: 'x', url: 'https://example.com', intervalMin: 0, timeoutSec: 1.5, headers: [{ name: 'bad name', value: '' }] },
  ],
  [webhookInputSchema, { name: 'x', url: 'https://example.com', minChangeTemp: 60 }],
  [startBrewSchema, { pillId: 'p', name: '  ', og: 1.5, targetFg: 0.9, startedAt: Number.NaN }],
  [startBrewSchema, { pillId: 'p', name: 'Stout', og: 'high' }],
  [pillPatchSchema, { color: 'red' }],
  [mqttSettingsSchema, mqtt],
];

describe('form checks', () => {
  it('words problems like the shared formErrorMap, in English', () => {
    for (const [schema, value] of CASES) {
      const errors = checkForm(schema, value);
      expect(Object.keys(errors).length).toBeGreaterThan(0);
      expect(errors).toEqual(checkInput(schema, value));
    }
  });

  it('translates them, including messages set on the schemas', () => {
    setCatalog('de', {
      Required: 'Erforderlich',
      'A colour like #a78bfa': 'Eine Farbe wie #a78bfa',
      'Use at most {count} character|Use at most {count} characters': {
        one: 'Höchstens {count} Zeichen',
        other: 'Höchstens {count} Zeichen',
      },
      'Must be at least {min}': 'Mindestens {min}',
      'Use a gravity between {min} and {max}': 'Eine Dichte zwischen {min} und {max}',
    });
    expect(checkForm(hubSettingsSchema, { ...hub, name: '' })).toEqual({ name: 'Erforderlich' });
    expect(checkForm(hubSettingsSchema, { ...hub, name: 'x'.repeat(41) })).toEqual({ name: 'Höchstens 40 Zeichen' });
    expect(checkForm(pillPatchSchema, { color: 'red' })).toEqual({ color: 'Eine Farbe wie #a78bfa' });
    expect(checkForm(webhookInputSchema, { name: 'x', url: 'https://example.com', intervalMin: 0.5 }).intervalMin).toBe('Mindestens 1');
    expect(gravityError('x', 1.5, (sg) => sg.toFixed(3))).toBe('Eine Dichte zwischen 0.950 und 1.200');
  });
});
