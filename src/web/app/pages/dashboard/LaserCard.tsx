import { useMemo, type CSSProperties } from 'react';
import type { Pill } from '@rapthooker/shared';
import { useLive } from '../../live';
import { useUnits, volumeNumber } from '../../units';
import { useCardHistory, useCardRange } from '../../hooks';
import { href } from '../../router';
import { num, signalQuality, timeAgo, useNow } from '../../format';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';
import { Sparkline } from '../../components/Sparkline';
import { SignalBars } from '../../components/ui';
import { pillStatus } from './PillRow';
import { ThermometerBadge } from './ThermometerCard';
import { KegBar, KegStrip, vesselOf, volumeSeries } from '../devices/keg';

/**
 * A RAPT Laser Level on the dashboard: the beer on tap or how full its keg is, a chart of it (and the temperature), and
 * its temperature and battery.
 */
export function LaserCard({ pill }: { pill: Pill }) {
  const u = useUnits();
  const { cachedAt } = useLive();
  const now = useNow(15_000);
  const range = useCardRange(pill);
  const { history } = useCardHistory(pill, range);
  const r = pill.live.latest;
  const vessel = vesselOf(pill);
  const scale = u.volumeScale(pill.servingUnit);
  const signal = signalQuality(pill.live.rssi);
  const status = pillStatus(pill, cachedAt);
  const volume = useMemo(() => (history ? volumeSeries(history, vessel) : null), [history, vessel]);

  return (
    <article className={`panel pill-card${pill.live.online ? '' : ' offline'}`} style={{ '--pill': pill.color } as CSSProperties}>
      <div className="pill-card-head">
        <ThermometerBadge color={pill.color} size={46} offline={!pill.live.online} icon="beer" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2>
            <a className="card-link" href={href.pill(pill.id)}>
              {pill.name}
            </a>
          </h2>
          <div className="sub">
            <span className={`status-dot${status.on ? ' on' : ''}`} aria-hidden="true" />
            {status.label} · {timeAgo(pill.live.lastReadingAt, now)}
          </div>
        </div>
        {pill.keg ? <span className="chip brew">{t('On tap')}</span> : <span className="chip">{t('Keg')}</span>}
      </div>

      {/* A beer on tap says how much of it is left itself. */}
      {pill.keg ? (
        <KegStrip keg={pill.keg} pill={pill} />
      ) : (
        <>
          <div className="big-readings">
            <div>
              <div className="reading-label">{t('In the keg')}</div>
              <div className="gravity-value">
                {volumeNumber(scale, r?.volume)}
                <span className="unit">{t('of {amount}', { amount: u.volumeText(vessel.capacity, pill.servingUnit, true) })}</span>
              </div>
            </div>
            <div className="temp-value">
              {r?.fill == null ? '–' : `${num(r.fill, 0)}%`}
              <div className="reading-label">{t('Full')}</div>
            </div>
          </div>
          <KegBar fill={r?.fill} color={pill.color} />
        </>
      )}

      {history && volume && history.ts.length > 1 && (
        <Sparkline
          ts={history.ts}
          values={volume}
          secondary={history.temperature}
          color={pill.color}
          from={range.from}
          to={Math.max(history.to, Date.now())}
          minSpan={1}
          secondaryMinSpan={3}
        />
      )}

      <div className="mini-stats">
        <div className="mini-stat">
          <span className="k">
            <Icon name="thermometer" size={12} /> {t('Temp')}
          </span>
          <span className="num">{u.tempText(r?.temperature)}</span>
        </div>
        <div className="mini-stat">
          <span className="k">
            <Icon name="battery" size={12} /> {t('Battery')}
          </span>
          <span className={r?.battery != null && r.battery < 20 ? 'low' : undefined}>
            {r?.battery != null ? `${Math.round(r.battery)}%` : '–'}
          </span>
        </div>
        <div className="mini-stat" title={signal ? t('{rssi} dBm at the hub', { rssi: signal.rssi }) : undefined}>
          <span className="k">
            <Icon name="signal" size={12} /> {t('Signal')}
          </span>
          <span className={`signal-quality ${signal?.quality ?? ''}`}>{signal ? signal.label : '–'}</span>
          <SignalBars rssi={pill.live.rssi} />
        </div>
        <div className="mini-stat">
          <span className="k">
            <Icon name="activity" size={12} /> {t('Distance')}
          </span>
          <span className="num">{r?.distance == null ? '–' : t('{mm} mm', { mm: num(r.distance, 0) })}</span>
        </div>
      </div>
    </article>
  );
}
