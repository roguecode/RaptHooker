import type { Pill } from '@rapthooker/shared';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { fixed, timeAgo, timeUntil, useNow } from '../../format';
import { Icon } from '../../components/Icon';
import { PillFigure } from '../../components/PillFigure';
import { OwnerOnly } from '../../components/ui';
import { t } from '../../i18n';
import { ThermometerBadge } from '../dashboard/ThermometerCard';
import { BrewPanel } from './BrewPanel';
import { DataPanel } from './Tiles';
import { HistoryPanel } from './HistoryPanel';
import { PillSettings } from './PillSettings';
import './pill.css';

export function PillPage({ id }: { id: string }) {
  const { pills, loaded } = useLive();
  const pill = pills.find((p) => p.id === id);
  if (!loaded) return <div className="skeleton" style={{ height: '20rem' }} />;
  if (!pill) {
    return (
      <div className="panel empty">
        <h2>{t('Pill not found')}</h2>
        <p>{t('It may have been removed.')}</p>
        <a className="btn" href="#/">
          {t('Back to the dashboard')}
        </a>
      </div>
    );
  }
  return <PillView pill={pill} />;
}

function PillView({ pill }: { pill: Pill }) {
  const u = useUnits();
  const now = useNow(10_000);
  const { isOwner } = useLive();
  const r = pill.live.latest;
  const g = u.gravityParts(r?.gravity);
  const next = pill.live.lastReadingAt && pill.live.intervalSec ? pill.live.lastReadingAt + pill.live.intervalSec * 1000 : null;
  const thermometer = pill.kind === 'thermometer';

  return (
    <div className="page pill-page">
      <div>
        <a className="back" href="#/">
          <Icon name="left" size={16} /> {t('All pills')}
        </a>
        <div className="panel hero" style={{ '--pill': pill.color } as React.CSSProperties}>
          {thermometer ? (
            <ThermometerBadge color={pill.color} size={92} offline={!pill.live.online} />
          ) : (
            <PillFigure color={pill.color} tilt={r?.tilt} size={92} offline={!pill.live.online} />
          )}
          <div style={{ minWidth: 0 }}>
            <div className="row">
              <h1>{pill.name}</h1>
              {pill.archived && <span className="chip warning">{t('Archived')}</span>}
              {r && !r.plausible && (
                <span className="chip warning" title={t("The latest reading doesn't look like the pill is floating")}>
                  <Icon name="alert" size={12} /> {t('Not floating?')}
                </span>
              )}
            </div>
            <div className="meta">
              <span className="row" style={{ gap: '0.35rem' }}>
                <span className={`status-dot${pill.live.online ? ' on' : ''}`} /> {pill.live.online ? t('Online') : t('Offline')}
              </span>
              <span>{t('Last reading {time}', { time: timeAgo(pill.live.lastReadingAt, now) })}</span>
              {/* i18n: when the next reading is due, e.g. "Next in 5 min" */}
              {pill.live.online && next && <span>{t('Next {time}', { time: timeUntil(next, now) })}</span>}
              <span className="num">{thermometer ? pill.address : `RAPT ID ${pill.raptId}`}</span>
            </div>
          </div>
          <div className="hero-figures">
            {thermometer ? (
              <div>
                <div className="reading-label">{t('Temperature')}</div>
                <div className="gravity-value">
                  {r ? fixed(u.tempValue(r.temperature), 1) : '–'}
                  <span className="unit">{u.tempLabel}</span>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <div className="reading-label">
                    {t('Gravity')}
                    {pill.model.gravitySource === 'tilt' ? ` · ${t('from tilt')}` : ''}
                    {pill.model.smoothing !== 'off' ? ` · ${t('smoothed')}` : ''}
                  </div>
                  <div className="gravity-value">
                    {g.main}
                    <span className="tail">{g.tail}</span>
                    <span className="unit">{g.unit}</span>
                  </div>
                </div>
                <div>
                  <div className="reading-label">{t('Temperature')}</div>
                  <div className="temp-value">{r ? u.tempText(r.temperature) : '–'}</div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {!thermometer && r && !r.plausible && (
        <div className="notice warning" role="status">
          <Icon name="alert" />
          <p>
            <strong>{t('This reading looks wrong: is the pill floating?')}</strong>{' '}
            {t("It isn't used for brew stats, gravity alerts or (by default) webhooks.")}
          </p>
        </div>
      )}
      {!thermometer && <BrewPanel pill={pill} />}
      <HistoryPanel pill={pill} />
      <DataPanel pill={pill} now={now} />
      {isOwner ? <PillSettings pill={pill} /> : <OwnerOnly isOwner={false}>{null}</OwnerOnly>}
    </div>
  );
}
