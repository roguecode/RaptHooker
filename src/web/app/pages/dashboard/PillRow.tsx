import type { CSSProperties } from 'react';
import { plausibleGravity, type Pill } from '@rapthooker/shared';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { href } from '../../router';
import { signalQuality, timeAgo, useNow } from '../../format';
import { Icon } from '../../components/Icon';
import { fixed } from '../../format';
import { t } from '../../i18n';

/** "Online"/"Offline", or "Last reading" while the page shows saved data (the hub's view isn't known then). */
export function pillStatus(pill: Pill, cachedAt: number | null): { label: string; on: boolean } {
  if (cachedAt !== null) return { label: t('Last reading'), on: false };
  return pill.live.online ? { label: t('Online'), on: true } : { label: t('Offline'), on: false };
}

/** A pill (or thermometer) as one dense row (the dashboard's compact view). */
export function PillRow({ pill }: { pill: Pill }) {
  const u = useUnits();
  const { cachedAt } = useLive();
  const now = useNow(15_000);
  const r = pill.live.latest;
  const v = r?.velocity ?? null;
  const abv = pill.brew?.stats.abv ?? null;
  const status = pillStatus(pill, cachedAt);
  const thermometer = pill.kind === 'thermometer';
  const signal = signalQuality(pill.live.rssi);
  return (
    <li className={`pill-row${pill.live.online ? '' : ' offline'}`} style={{ '--pill': pill.color } as CSSProperties}>
      <span className="pill-row-swatch" aria-hidden="true" />
      <div className="pill-row-name">
        <a className="card-link" href={href.pill(pill.id)}>
          {pill.name}
        </a>
        <span className="sub">
          <span className={`status-dot${status.on ? ' on' : ''}`} aria-hidden="true" />
          <span className="sr-only">{status.label}, </span>
          {thermometer ? t('Thermometer') : pill.brew ? pill.brew.name : t('No brew')} · {timeAgo(pill.live.lastReadingAt, now)}
        </span>
      </div>
      {thermometer ? (
        <>
          <div className="pill-row-val main">
            <span className="k">{t('Temp')}</span>
            <span className="v">{u.tempText(r?.temperature)}</span>
          </div>
          <div className="pill-row-val">
            <span className="k">{t('Signal')}</span>
            <span className={`v signal-quality ${signal?.quality ?? ''}`}>{signal ? signal.label : '–'}</span>
          </div>
          {/* What a thermometer doesn't measure: the columns stay, so the rows line up. */}
          <div className="pill-row-val wide" aria-hidden="true" />
          <div className="pill-row-val wide" aria-hidden="true" />
          <div className="pill-row-val wide" aria-hidden="true" />
        </>
      ) : (
        <>
          <div className="pill-row-val main">
            <span className="k">{t('Gravity')}</span>
            <span className="v">
              {u.gravityText(r?.gravity)}
              {r && r.gravity !== null && !plausibleGravity(r.gravity) && (
                <span className="pill-row-warn" title={t('Gravity looks wrong: is the pill floating?')}>
                  <Icon name="alert" size={14} />
                  <span className="sr-only">{t('(looks wrong: is the pill floating?)')}</span>
                </span>
              )}
            </span>
          </div>
          <div className="pill-row-val">
            <span className="k">{t('Temp')}</span>
            <span className="v">{u.tempText(r?.temperature)}</span>
          </div>
          <div className="pill-row-val wide">
            <span className="k">{t('Velocity')}</span>
            <span className="v">
              {v === null ? '–' : `${v > 0 ? '+' : ''}${fixed(v, 1)}`}
              {/* i18n: gravity points per day (how fast the gravity is falling) */}
              {v !== null && <small> {t('pts/day')}</small>}
            </span>
          </div>
          <div className="pill-row-val wide">
            <span className="k">ABV</span>
            <span className="v">{abv === null ? '–' : `${fixed(abv, 1)}%`}</span>
          </div>
          <div className="pill-row-val wide">
            <span className="k">{t('Battery')}</span>
            <span className={`v${r?.battery != null && r.battery < 20 ? ' low' : ''}`}>
              {r?.battery != null ? `${Math.round(r.battery)}%` : '–'}
            </span>
          </div>
        </>
      )}
    </li>
  );
}
