import { describe, expect, it } from 'vitest';
import { ABV_FORMULAS, type Brew, type BrewStats } from '@rapthooker/shared';
import { abvOf, brewDay, finishText, summaryText } from './brewText';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1, 12);

const stats = (over: Partial<BrewStats> = {}): BrewStats => ({
  og: 1.052,
  ogAuto: true,
  gravity: 1.012,
  abv: 5.25,
  attenuation: 76.9,
  tempMin: 18,
  tempMax: 20.5,
  tempAvg: 19.2,
  readings: 900,
  firstReadingAt: START,
  lastReadingAt: START + 6 * DAY,
  stable: false,
  finalAbv: null,
  prediction: null,
  ...over,
});

const brew = (over: Partial<Brew> = {}): Brew => ({
  id: 'b1',
  pillId: 'p1',
  name: 'Hazy IPA',
  style: 'New England IPA',
  notes: 'Pitched warm.',
  og: null,
  targetFg: 1.012,
  startedAt: START,
  endedAt: null,
  stats: stats(),
  events: [{ id: 'e1', brewId: 'b1', at: START + 2.5 * DAY, kind: 'dry_hop', text: '100 g Citra' }],
  ...over,
});

const units = {
  gravityText: (sg: number | null | undefined) => (sg == null ? '–' : sg.toFixed(4)),
  tempText: (c: number | null | undefined) => (c == null ? '–' : `${c.toFixed(1)} °C`),
};

describe('brew text', () => {
  it('shows the ABV so far until it is final', () => {
    expect(abvOf(brew())).toEqual({ value: 5.25, final: false });
    expect(abvOf(brew({ stats: stats({ stable: true, finalAbv: 5.3 }) }))).toEqual({ value: 5.3, final: true });
  });

  it('numbers the days of a brew from 1', () => {
    expect(brewDay(START, START + 1000)).toBe('Day 1');
    expect(brewDay(START, START + 2.5 * DAY)).toBe('Day 3');
    expect(brewDay(START, START - 1000)).toBe('Before the start');
  });

  it('says when a brew should finish', () => {
    const p = { stage: 'finishing', fg: 1.011, finishAt: START + DAY, confidence: 'high', fittedAt: START } as const;
    expect(finishText(p, START + 2 * DAY)).toBe('Any time now');
    expect(finishText({ ...p, finishAt: null }, START)).toBe("Can't tell yet");
    expect(finishText({ ...p, stage: 'lag', finishAt: null }, START)).toBe('Once it gets going');
  });

  it('writes a plain-text summary naming the ABV formula', () => {
    const formula = ABV_FORMULAS.find((f) => f.id === 'alternative')!;
    const text = summaryText(brew({ endedAt: START + 7 * DAY, stats: stats({ finalAbv: 5.4 }) }), 'Purple', units, formula);
    expect(text.split('\n')[0]).toBe('Hazy IPA');
    expect(text).toContain('Pill: Purple');
    expect(text).toContain('OG: 1.0520 (from the pill)');
    expect(text).toContain('FG: 1.0120');
    expect(text).toContain('ABV: 5.40% (alternative formula: 76.08 × (OG − FG) / (1.775 − OG) × FG / 0.794)');
    expect(text).toContain('Temperature: 18.0 °C to 20.5 °C, average 19.2 °C');
    expect(text).toMatch(/- Day 3, .*: Dry hop: 100 g Citra/);
    expect(text).toContain('Notes:\nPitched warm.');
    expect(text).toContain('(7.0 days)');

    const running = summaryText(
      brew({ stats: stats({ prediction: { stage: 'active', fg: 1.011, finishAt: null, confidence: 'medium', fittedAt: START } }) }),
      null,
      units,
      ABV_FORMULAS[0]!,
      START + 3 * DAY,
    );
    expect(running).toContain('ABV so far: 5.25% (standard formula: (OG − FG) × 131.25)');
    expect(running).toContain('Gravity now: 1.0120');
    expect(running).toContain('Stage: Fermenting');
    expect(running).toContain('Predicted FG: 1.0110 (medium confidence)');
    expect(running).not.toContain('Pill:');
  });
});
