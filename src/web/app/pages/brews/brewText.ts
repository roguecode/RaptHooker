import { ABV_FORMULAS, type AbvFormula, type Brew, type BrewEventKind, type BrewPrediction, type BrewStage } from '@rapthooker/shared';
import { dateTime, days, fixed } from '../../format';
import { t, tk } from '../../i18n';

/** Plain helpers for the brew pages (no React), shared by the pages, the pill's brew panel and the summary. */

const DAY = 86_400_000;

/** Colours match the chart markers (components/annotations.ts). Icons are names from components/Icon.tsx. */
export const EVENT_KINDS = [
  { kind: 'dry_hop', label: tk('Dry hop'), icon: 'leaf', color: 'var(--success)', placeholder: tk('100 g Citra') },
  {
    kind: 'temp_change',
    label: tk('Temperature change'),
    icon: 'thermometer',
    color: 'var(--series-temp)',
    placeholder: tk('Up to 21 °C for a diacetyl rest'),
  },
  { kind: 'cold_crash', label: tk('Cold crash'), icon: 'snowflake', color: 'var(--cyan)', placeholder: tk('Down to 2 °C') },
  { kind: 'addition', label: tk('Addition'), icon: 'flask', color: 'var(--warning)', placeholder: tk('Yeast nutrient, fruit, finings…') },
  { kind: 'note', label: tk('Note'), icon: 'note', color: 'var(--muted)', placeholder: tk('Krausen has dropped') },
] as const satisfies readonly { kind: BrewEventKind; label: string; icon: string; color: string; placeholder: string }[];

export const eventKind = (kind: BrewEventKind) => EVENT_KINDS.find((k) => k.kind === kind) ?? EVENT_KINDS[EVENT_KINDS.length - 1]!;

/** Which day of the brew a time falls on ("Day 1" is the first 24 hours). */
export const brewDay = (startedAt: number, at: number) =>
  at < startedAt ? t('Before the start') : t('Day {day}', { day: Math.floor((at - startedAt) / DAY) + 1 });

export const STAGES: Record<BrewStage, { label: string; hint: string; chip: string }> = {
  lag: { label: tk('Lag phase'), hint: tk("The yeast is getting going: the gravity hasn't started dropping yet."), chip: '' },
  active: { label: tk('Fermenting'), hint: tk('The gravity is dropping fast.'), chip: 'brew' },
  finishing: { label: tk('Finishing'), hint: tk('Slowing down: under a quarter of its fastest rate.'), chip: 'warning' },
  // i18n: the stage of a fermentation that has finished
  done: { label: tk('Done'), hint: tk('The gravity has stopped moving (less than a point in 48 hours).'), chip: 'success' },
};

/** How sure the FG prediction is, in words (translate with t()). */
export const CONFIDENCE_WORDS: Record<BrewPrediction['confidence'], string> = {
  low: tk('low confidence'),
  medium: tk('medium confidence'),
  high: tk('high confidence'),
};

export const formulaOf = (id: AbvFormula) => ABV_FORMULAS.find((f) => f.id === id) ?? ABV_FORMULAS[0]!;

/** "standard formula" or "alternative formula", for use in a sentence. */
export const formulaWords = (f: { id: AbvFormula }) => (f.id === 'alternative' ? t('alternative formula') : t('standard formula'));

/** The ABV to show: final once the gravity has settled or the brew has ended, otherwise so far. */
export function abvOf(brew: Brew): { value: number | null; final: boolean } {
  const s = brew.stats;
  return s.finalAbv !== null ? { value: s.finalAbv, final: true } : { value: s.abv, final: false };
}

export function finishText(p: BrewPrediction, now: number): string {
  if (p.stage === 'done') return p.finishAt ? t('Since {date}', { date: dateTime(p.finishAt) }) : t('Finished');
  if (p.finishAt === null) return p.stage === 'lag' ? t('Once it gets going') : t("Can't tell yet");
  if (p.finishAt <= now) return t('Any time now');
  return t('{date} (in {time})', { date: dateTime(p.finishAt), time: days(p.finishAt - now) });
}

/** What the summary needs from the units in use (see useUnits). */
export interface SummaryUnits {
  gravityText: (sg: number | null | undefined) => string;
  tempText: (c: number | null | undefined, decimals?: number) => string;
}

/** A brew summary as plain text, in the language in use, for pasting into a forum post, a recipe app or a message. */
export function summaryText(
  brew: Brew,
  pillName: string | null,
  u: SummaryUnits,
  formula: { id: AbvFormula; formula: string },
  now = Date.now(),
): string {
  const s = brew.stats;
  const abv = abvOf(brew);
  const running = brew.endedAt === null;
  const lines: string[] = [brew.name];
  if (brew.style) lines.push(brew.style);
  lines.push('');
  if (pillName) lines.push(t('Pill: {name}', { name: pillName }));
  lines.push(t('Started: {date}', { date: dateTime(brew.startedAt) }));
  lines.push(
    running
      ? t('Still fermenting ({days} so far)', { days: days(now - brew.startedAt) })
      : t('Ended: {date} ({days})', { date: dateTime(brew.endedAt), days: days(brew.endedAt! - brew.startedAt) }),
  );
  const og = u.gravityText(s.og);
  lines.push(s.ogAuto && s.og !== null ? t('OG: {gravity} (from the pill)', { gravity: og }) : t('OG: {gravity}', { gravity: og }));
  const gravity = u.gravityText(s.gravity);
  lines.push(running ? t('Gravity now: {gravity}', { gravity }) : t('FG: {gravity}', { gravity }));
  if (brew.targetFg !== null) lines.push(t('Target FG: {gravity}', { gravity: u.gravityText(brew.targetFg) }));
  if (abv.value !== null) {
    const vars = { abv: fixed(abv.value, 2), formula: formulaWords(formula), math: formula.formula };
    lines.push(abv.final ? t('ABV: {abv}% ({formula}: {math})', vars) : t('ABV so far: {abv}% ({formula}: {math})', vars));
  }
  if (s.attenuation !== null) lines.push(t('Apparent attenuation: {value}%', { value: fixed(s.attenuation, 1) }));
  if (s.tempAvg !== null) {
    lines.push(
      t('Temperature: {min} to {max}, average {avg}', {
        min: u.tempText(s.tempMin),
        max: u.tempText(s.tempMax),
        avg: u.tempText(s.tempAvg),
      }),
    );
  }
  const p = s.prediction;
  if (running && p) {
    lines.push(t('Stage: {stage}', { stage: t(STAGES[p.stage].label) }));
    if (p.stage === 'active' || p.stage === 'finishing') {
      lines.push(
        t('Predicted FG: {gravity} ({confidence}), finish: {finish}', {
          gravity: u.gravityText(p.fg),
          confidence: t(CONFIDENCE_WORDS[p.confidence]),
          finish: finishText(p, now),
        }),
      );
    }
  }
  if (brew.events.length > 0) {
    lines.push('', t('Timeline:'));
    for (const e of brew.events) {
      const label = e.kind === 'note' ? t('Note') : t(eventKind(e.kind).label);
      lines.push(`- ${brewDay(brew.startedAt, e.at)}, ${dateTime(e.at)}: ${label}${e.text ? `: ${e.text}` : ''}`);
    }
  }
  if (brew.notes.trim()) lines.push('', t('Notes:'), brew.notes.trim());
  lines.push('', t('Recorded with RaptHooker'));
  return lines.join('\n');
}
