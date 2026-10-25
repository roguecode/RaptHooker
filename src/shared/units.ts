import type { AbvFormula, GravityUnit, TemperatureUnit } from './types.js';

/** Degrees Plato from specific gravity (the usual cubic fit). */
export function sgToPlato(sg: number): number {
  return -616.868 + 1111.14 * sg - 630.272 * sg ** 2 + 135.997 * sg ** 3;
}

/** Specific gravity from degrees Plato. */
export function platoToSg(plato: number): number {
  return 1 + plato / (258.6 - (plato / 258.2) * 227.1);
}

export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const fToC = (f: number): number => ((f - 32) * 5) / 9;

export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function gravityIn(sg: number, unit: GravityUnit): number {
  return unit === 'plato' ? round(sgToPlato(sg), 2) : round(sg, 4);
}

export function gravityFrom(value: number, unit: GravityUnit): number {
  return unit === 'plato' ? platoToSg(value) : value;
}

export function temperatureIn(c: number, unit: TemperatureUnit): number {
  return unit === 'F' ? round(cToF(c), 2) : round(c, 2);
}

export function temperatureFrom(value: number, unit: TemperatureUnit): number {
  return unit === 'F' ? fToC(value) : value;
}

/** A temperature difference (offsets, hysteresis) converted between units. */
export function temperatureDeltaIn(deltaC: number, unit: TemperatureUnit): number {
  return unit === 'F' ? (deltaC * 9) / 5 : deltaC;
}

/**
 * ABV from original and current gravity.
 * 'standard': the common homebrew formula, (OG − FG) × 131.25.
 * 'alternative': stays accurate for strong beers (Daniels/Hall: 76.08 × (OG − FG) / (1.775 − OG) × FG / 0.794).
 */
export function abv(og: number, fg: number, formula: AbvFormula = 'standard'): number {
  if (!(og > 1) || !(fg > 0)) return 0;
  if (formula === 'standard') return Math.max(0, (og - fg) * 131.25);
  return Math.max(0, ((76.08 * (og - fg)) / (1.775 - og)) * (fg / 0.794));
}

export const ABV_FORMULAS: { id: AbvFormula; label: string; formula: string }[] = [
  { id: 'standard', label: 'Standard', formula: '(OG − FG) × 131.25' },
  { id: 'alternative', label: 'Alternative (better for strong beers)', formula: '76.08 × (OG − FG) / (1.775 − OG) × FG / 0.794' },
];

/** Apparent attenuation, %. */
export function attenuation(og: number, fg: number): number {
  if (!(og > 1)) return 0;
  return ((og - fg) / (og - 1)) * 100;
}

/** Gravity points: 1.050 → 50. */
export const points = (sg: number): number => (sg - 1) * 1000;
