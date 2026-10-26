import { useMemo, type CSSProperties } from 'react';
import type { Pill } from '@rapthooker/shared';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { useHistory, useRecentRange } from '../../hooks';
import { href } from '../../router';
import { fixed, signalQuality, timeAgo, timeUntil, useNow } from '../../format';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';
import { Sparkline } from '../../components/Sparkline';
import { SignalBars } from '../../components/ui';
import { caughtPercent } from '../pill/Tiles';
import { pillStatus } from './PillRow';

const DAY = 86_400_000;

/** The thermometer's colour in a circle, in place of a pill's figure. */
export function ThermometerBadge({ color, size, offline = false }: { color: string; size: number; offline?: boolean }) {
  return (
    <span
      className={`thermo-badge${offline ? ' offline' : ''}`}
      style={{ '--pill': color, width: size, height: size } as CSSProperties}
      aria-hidden="true"
    >
      <Icon name="thermometer" size={Math.round(size * 0.55)} />
    </span>
  );
}

/** Lowest and highest of a series, ignoring gaps. */
export function rangeOf(values: (number | null)[] | undefined): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values ?? []) {
    if (v === null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? { min, max } : null;
}

/** A RAPT Thermometer on the dashboard: its temperature, the last day of it, and how well it's heard. */
export function ThermometerCard({ pill }: { pill: Pill }) {
  const u = useUnits();
  const { cachedAt } = useLive();
  const now = useNow(15_000);
  const range = useRecentRange(DAY);
  const { history } = useHistory(pill.id, range, 160);
  const r = pill.live.latest;
  const signal = signalQuality(pill.live.rssi);
  const next = pill.live.lastReadingAt && pill.live.intervalSec ? pill.live.lastReadingAt + pill.live.intervalSec * 1000 : null;
  const status = pillStatus(pill, cachedAt);
  const day = useMemo(() => rangeOf(history?.temperature), [history]);
  const pct = caughtPercent(pill.live.caught);

  return (
    <article className={`panel pill-card${pill.live.online ? '' : ' offline'}`} style={{ '--pill': pill.color } as CSSProperties}>
      <div className="pill-card-head">
        <ThermometerBadge color={pill.color} size={46} offline={!pill.live.online} />
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
        <span className="chip">{t('Thermometer')}</span>
      </div>

      <div className="big-readings">
        <div>
          <div className="reading-label">{t('Temperature')}</div>
          <div className="gravity-value">
            {r ? fixed(u.tempValue(r.temperature), 1) : '–'}
            <span className="unit">{u.tempLabel}</span>
          </div>
        </div>
      </div>

      {history && history.ts.length > 1 && (
        <Sparkline
          ts={history.ts}
          values={history.temperature}
          color={pill.color}
          from={range.from}
          to={Math.max(history.to, Date.now())}
          minSpan={2}
        />
      )}

      <div className="mini-stats">
        <div className="mini-stat" title={signal ? t('{rssi} dBm at the hub', { rssi: signal.rssi }) : undefined}>
          <span className="k">
            <Icon name="signal" size={12} /> {t('Signal')}
          </span>
          <span className={`signal-quality ${signal?.quality ?? ''}`}>{signal ? signal.label : '–'}</span>
          <SignalBars rssi={pill.live.rssi} />
        </div>
        <div className="mini-stat">
          <span className="k">
            <Icon name="activity" size={12} /> {t('Last 24 h')}
          </span>
          <span className="num">{day ? `${fixed(u.tempValue(day.min), 1)}–${fixed(u.tempValue(day.max), 1)} ${u.tempLabel}` : '–'}</span>
        </div>
        <div className="mini-stat">
          <span className="k">
            {/* i18n: the share of the expected readings that arrived */}
            <Icon name="check" size={12} /> {t('Caught')}
          </span>
          {pct === null ? '–' : `${pct}%`}
        </div>
        <div className="mini-stat">
          <span className="k">
            <Icon name="clock" size={12} /> {t('Next')}
          </span>
          {pill.live.online && !cachedAt ? timeUntil(next, now) : '–'}
        </div>
      </div>
    </article>
  );
}
