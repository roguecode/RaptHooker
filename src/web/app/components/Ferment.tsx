import type { Brew } from '@rapthooker/shared';
import { useUnits } from '../units';
import { fixed } from '../format';
import { t } from '../i18n';

/** Where a brew is between its original and target final gravity. */
export function fermentProgress(brew: Brew): { pct: number; target: number } | null {
  const { og, gravity } = brew.stats;
  if (og === null || gravity === null || og <= 1) return null;
  // Without a target, assume a typical 75% attenuation.
  const target = brew.targetFg ?? og - (og - 1) * 0.75;
  if (og - target <= 0) return null;
  return { pct: Math.max(0, Math.min(100, ((og - gravity) / (og - target)) * 100)), target };
}

export function FermentBar({ brew, compact = false }: { brew: Brew; compact?: boolean }) {
  const u = useUnits();
  const p = fermentProgress(brew);
  return (
    <div className="ferment">
      <div className="ferment-top">
        <span className="name">
          <span aria-hidden="true">🍺 </span>
          {brew.name}
        </span>
        <span className="num">
          {brew.stats.abv !== null ? t('{abv}% ABV', { abv: fixed(brew.stats.abv, 1) }) : t('ABV –')}
          {brew.stats.attenuation !== null && !compact ? ` · ${t('{n}% att.', { n: fixed(brew.stats.attenuation, 0) })}` : ''}
        </span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label={t('Fermentation progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p?.pct ?? 0)}
      >
        <i style={{ width: `${p?.pct ?? 0}%` }} />
      </div>
      <div className="ferment-scale">
        <span>{t('OG {gravity}', { gravity: u.gravityText(brew.stats.og) })}</span>
        <span>{p ? t('{pct}% there', { pct: fixed(p.pct, 0) }) : t('Waiting for readings')}</span>
        <span>
          {brew.targetFg
            ? t('FG {gravity}', { gravity: u.gravityText(p?.target ?? brew.targetFg) })
            : // i18n: "~" means about: the final gravity expected without a target
              t('~FG {gravity}', { gravity: u.gravityText(p?.target ?? brew.targetFg) })}
        </span>
      </div>
    </div>
  );
}
