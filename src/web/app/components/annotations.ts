import type { AlertEvent, Brew, BrewEventKind } from '@rapthooker/shared';
import { t, tk } from '../i18n';

/** A moment marked on a chart: a dashed vertical line with a small label at the top. */
export interface ChartAnnotation {
  /** Unix ms. */
  ts: number;
  /** Unix ms, for something that lasted a while (a dry hop sitting for days): the time between is shaded, with a line at each end. */
  endTs?: number;
  label: string;
  /** Any CSS colour, including `var(--name)`. Defaults to the muted text colour. */
  color?: string;
}

/** English (marked with tk): show them with t(). */
export const EVENT_LABELS: Record<BrewEventKind, string> = {
  dry_hop: tk('Dry hop'),
  temp_change: tk('Temp change'),
  cold_crash: tk('Cold crash'),
  addition: tk('Addition'),
  note: tk('Note'),
};

export const EVENT_COLORS: Record<BrewEventKind, string> = {
  dry_hop: 'var(--success)',
  temp_change: 'var(--series-temp)',
  cold_crash: 'var(--cyan)',
  addition: 'var(--warning)',
  note: 'var(--muted)',
};

const MAX_LABEL = 28;

const short = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1).trimEnd()}…` : s);

/** A brew's start and its events (but not those hidden from the charts), for `<Chart annotations>`. */
export function brewAnnotations(
  brew: (Pick<Brew, 'startedAt' | 'endedAt'> & { events?: Brew['events'] }) | null | undefined,
): ChartAnnotation[] {
  if (!brew) return [];
  const out: ChartAnnotation[] = [{ ts: brew.startedAt, label: t('Brew started'), color: 'var(--violet-2)' }];
  for (const e of brew.events ?? []) {
    if (e.hidden) continue;
    const text = e.text.trim();
    const kind = t(EVENT_LABELS[e.kind] ?? 'Note');
    out.push({
      ts: e.at,
      ...(e.endAt != null && e.endAt > e.at ? { endTs: e.endAt } : {}),
      label: short(text ? t('{kind}: {text}', { kind, text }) : kind),
      color: EVENT_COLORS[e.kind],
    });
  }
  if (brew.endedAt) out.push({ ts: brew.endedAt, label: t('Brew ended'), color: 'var(--violet-2)' });
  return out.sort((a, b) => a.ts - b.ts);
}

/** When alerts went off and cleared, for `<Chart annotations>` (in the colours of the Alerts page's Recent list). */
export function alertAnnotations(events: readonly AlertEvent[]): ChartAnnotation[] {
  return events
    .map((e) => {
      const fired = e.kind === 'fired';
      // i18n: on a chart, where an alert went off ("Alert: Too warm") and where it went back to normal ("OK: Too warm")
      const label = fired ? t('Alert: {alert}', { alert: e.ruleName }) : t('OK: {alert}', { alert: e.ruleName });
      return { ts: e.at, label: short(label), color: fired ? 'var(--warning)' : 'var(--success)' };
    })
    .sort((a, b) => a.ts - b.ts);
}
