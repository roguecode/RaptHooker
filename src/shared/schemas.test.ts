import { describe, expect, it } from 'vitest';
import { alertInputSchema, checkInput, startBrewSchema, webhookInputSchema } from './schemas.js';

describe('request schemas', () => {
  it('fill in webhook defaults the way the API does', () => {
    expect(webhookInputSchema.parse({ name: ' BF ', url: 'https://example.com' })).toMatchObject({
      name: 'BF',
      enabled: true,
      method: 'POST',
      pillIds: 'all',
      intervalMin: 15,
      timeoutSec: 15,
    });
  });

  it('give the first problem for each field in plain words', () => {
    expect(checkInput(startBrewSchema, { pillId: 'p', name: '  ', og: 1.5, targetFg: 0.9, startedAt: Number.NaN })).toEqual({
      name: 'Required',
      og: 'Must be at most 1.2',
      targetFg: 'Must be at least 0.95',
      startedAt: 'Enter a number',
    });
    expect(
      checkInput(webhookInputSchema, { name: 'x', url: 'https://x', headers: [{ name: 'bad name', value: '' }], timeoutSec: 1.5 }),
    ).toEqual({
      'headers.0.name': 'Header names can only use letters, digits and -',
      timeoutSec: 'Use a whole number',
    });
    expect(checkInput(alertInputSchema, { name: 'Warm', kind: 'temp_above', threshold: 24 })).toEqual({});
  });

  it('leave the API its own wording', () => {
    const result = alertInputSchema.safeParse({ name: '', kind: 'temp_above', threshold: 1 });
    expect(result.error?.issues[0]?.message).toMatch(/^Too small/);
  });
});
