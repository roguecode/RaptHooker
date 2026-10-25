import { tk } from '../../i18n';

/**
 * Text from @rapthooker/shared that the brew pages show, listed so `npm run i18n` finds it (it doesn't read
 * src/shared). Each must match the shared text exactly; it's translated with t() where it's shown.
 */
export const SHARED_BREW_STRINGS = [
  // ABV_FORMULAS labels (units.ts)
  tk('Standard'),
  tk('Alternative (better for strong beers)'),
];
