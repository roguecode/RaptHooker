import { useEffect, useMemo, useState } from 'react';
import type { Brew, BrewCurve } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { fixed } from '../../format';
import { Icon } from '../../components/Icon';
import { COMPARE_COLORS, CompareChart, type CompareLine } from '../../components/CompareChart';
import { t, tp } from '../../i18n';
import { abvOf } from './brewText';
import { brewApi } from './api';

export const MAX_COMPARE = 8;

/** The selected brews' curves overlaid on one chart. */
export function ComparePanel({ ids, brews, onClear }: { ids: string[]; brews: Brew[]; onClear: () => void }) {
  const u = useUnits();
  const { toast } = useLive();
  const [curves, setCurves] = useState<BrewCurve[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTemp, setShowTemp] = useState(false);
  const key = ids.join(',');

  useEffect(() => {
    if (ids.length < 2) return;
    let cancelled = false;
    setError(null);
    brewApi.compare(ids).then(
      (c) => !cancelled && setCurves(c),
      (err) => {
        if (cancelled) return;
        setError(errorText(err));
        toast({ tone: 'error', title: t("Couldn't compare those brews"), body: errorText(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const lines = useMemo<CompareLine[]>(
    () =>
      (curves ?? [])
        .filter((c) => ids.includes(c.brewId))
        .map((c) => {
          const b = brews.find((x) => x.id === c.brewId);
          const abv = b ? abvOf(b) : null;
          const abvText = abv?.value == null ? '–' : `${fixed(abv.value, 1)}%`;
          const detail = b
            ? `${u.gravityText(b.stats.og)} → ${u.gravityText(b.stats.gravity)} · ${
                b.endedAt === null ? t('{abv} ABV so far', { abv: abvText }) : t('{abv} ABV', { abv: abvText })
              }`
            : undefined;
          return {
            id: c.brewId,
            label: c.name,
            color: COMPARE_COLORS[ids.indexOf(c.brewId) % COMPARE_COLORS.length]!,
            detail,
            hours: c.hours,
            gravity: c.gravity,
            temperature: c.temperature,
          };
        }),
    [curves, brews, key, u], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <section className="panel compare-panel">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="layers" /> {tp(ids.length, 'Comparing {count} brew', 'Comparing {count} brews')}
          </h2>
          <p>{t('Gravity by days since each brew started.')}</p>
        </div>
        <div className="chips">
          <button type="button" className={`chip${showTemp ? ' on' : ''}`} onClick={() => setShowTemp((v) => !v)}>
            <Icon name="thermometer" size={12} /> {t('Temperature')}
          </button>
          <button type="button" className="chip" onClick={onClear}>
            <Icon name="x" size={12} /> {t('Clear')}
          </button>
        </div>
      </div>
      {error && !curves ? (
        <p className="muted">{error}</p>
      ) : !curves ? (
        <div className="skeleton" style={{ height: '18rem' }} />
      ) : (
        <CompareChart lines={lines} showTemp={showTemp} />
      )}
    </section>
  );
}
