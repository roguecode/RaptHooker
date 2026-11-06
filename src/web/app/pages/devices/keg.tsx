import type { CSSProperties } from 'react';
import { DEFAULT_VESSEL, vesselFill, type History, type Keg, type Pill, type Vessel } from '@rapthooker/shared';
import { useUnits } from '../../units';
import { fixed } from '../../format';
import { t } from '../../i18n';

/** The keg under a RAPT Laser Level. */
export const vesselOf = (pill: Pick<Pill, 'vessel'>): Vessel => pill.vessel ?? DEFAULT_VESSEL;

/** A kegged-up beer's name; it's optional. */
export const kegName = (keg: Pick<Keg, 'name'>): string => keg.name || t('Unnamed beer');

/** How much of a kegged-up beer is left and has been poured, in litres (null until there are readings). */
export function kegLevels(keg: Keg, left: number | null | undefined): { left: number | null; poured: number | null; pct: number | null } {
  const now = left ?? null;
  const start = keg.startVolume;
  if (now === null || start === null) return { left: now, poured: null, pct: null };
  return { left: now, poured: Math.max(0, start - now), pct: start > 0 ? Math.max(0, Math.min(100, (now / start) * 100)) : null };
}

/** Litres in the keg at each point of a Laser Level's history. */
export const volumeSeries = (h: History, vessel: Vessel): (number | null)[] =>
  (h.distance ?? h.ts.map(() => null)).map((d) => vesselFill(d, vessel)?.volume ?? null);

/** Below this the bar shows the keg is nearly empty. */
export const LOW_FILL = 15;

/** How full the keg is, as a bar. */
export function KegBar({ fill, color }: { fill: number | null | undefined; color: string }) {
  const pct = fill === null || fill === undefined ? 0 : Math.max(0, Math.min(100, fill));
  return (
    <div
      className={`keg-bar${fill != null && fill < LOW_FILL ? ' low' : ''}`}
      style={{ '--pill': color } as CSSProperties}
      role="meter"
      aria-label={t('How full the keg is')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fill == null ? undefined : Math.round(pct)}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The beer kegged up under a Laser Level, on its card: like a brew's progress, but how much is left. */
export function KegStrip({ keg, pill }: { keg: Keg; pill: Pill }) {
  const u = useUnits();
  const own = pill.servingUnit;
  const { left, poured, pct } = kegLevels(keg, pill.live.latest?.volume);
  return (
    <div className="ferment keg-strip">
      <div className="ferment-top">
        <span className="name">
          <span aria-hidden="true">🍺 </span>
          {kegName(keg)}
          {keg.style && <span className="muted"> · {keg.style}</span>}
        </span>
        {keg.abv !== null && <span className="num">{t('{abv}% ABV', { abv: fixed(keg.abv, 1) })}</span>}
      </div>
      <div
        className="bar"
        role="meter"
        aria-label={t('How much of the beer is left')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
      >
        <i style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="ferment-scale">
        <span>{t('Kegged {amount}', { amount: u.volumeText(keg.startVolume, own, true) })}</span>
        <span>{pct === null ? t('Waiting for readings') : t('{amount} left', { amount: u.volumeText(left, own) })}</span>
        <span>{t('{amount} poured', { amount: u.volumeText(poured, own) })}</span>
      </div>
    </div>
  );
}
