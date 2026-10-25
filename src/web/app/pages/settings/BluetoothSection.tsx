import type { BleStatus, Pill } from '@rapthooker/shared';
import { useLive } from '../../live';
import { href } from '../../router';
import { timeAgo, useNow } from '../../format';
import { t, tp } from '../../i18n';
import { Icon } from '../../components/Icon';
import './BluetoothSection.css';

/** Below this share of the expected readings, the hub is missing too many transmissions. */
const LOW_CATCH = 0.85;
const RELAY_GUIDE = 'https://github.com/roguecode/RaptHooker/blob/main/docs/relay.md';

function ModeLine({ ble }: { ble: BleStatus }) {
  if (ble.state === 'mock') return <>{t('Simulated pills (development mode)')}</>;
  if (ble.state === 'starting') return <>{t('Starting…')}</>;
  if (ble.state !== 'scanning') return <>{t('Not listening: {error}', { error: ble.error ?? t('Bluetooth is unavailable') })}</>;
  if (ble.mode === 'passive') {
    return (
      <>
        <strong>{t('Passive')}</strong> · {t('only listens, so Wi-Fi keeps more of the radio it shares with Bluetooth')}
      </>
    );
  }
  return (
    <>
      <strong>{t('Active')}</strong> · {t('ordinary scanning, which keeps the shared radio busier and can slow a Pi 3’s Wi-Fi')}
    </>
  );
}

function CaughtRow({ pill, now }: { pill: Pill; now: number }) {
  const caught = pill.live.caught;
  const share = caught && caught.expected > 0 ? Math.min(1, caught.received / caught.expected) : null;
  const low = share !== null && share < LOW_CATCH;
  const hours = caught ? Math.max(1, Math.round((now - caught.since) / 3_600_000)) : 0;
  return (
    <div className="list-item bt-caught">
      <span className="status-dot" style={{ background: pill.color }} />
      <div className="grow">
        <h4>
          <a href={href.pill(pill.id)}>{pill.name}</a>
        </h4>
        {caught && share !== null ? (
          <>
            <div className={`bar bt-bar${low ? ' low' : ''}`} role="presentation">
              <i style={{ width: `${Math.round(share * 100)}%` }} />
            </div>
            <p>
              {tp(caught.received, '{count} reading of {expected}', '{count} readings of {expected}', { expected: caught.expected })}
              {' · '}
              {hours >= 24 ? t('last 24 hours') : tp(hours, 'last hour', 'last {count} hours')}
            </p>
            {low && (
              <p className="bt-low">
                {t(
                  'Missing readings. Move the hub closer to the fermenter, plug in a USB Bluetooth dongle away from the Pi, or set up a relay nearby.',
                )}
              </p>
            )}
          </>
        ) : (
          <p>{pill.live.lastReadingAt ? t('Not enough readings yet to tell.') : t('No readings yet.')}</p>
        )}
      </div>
      <span className={`chip${share === null ? '' : low ? ' warning' : ' success'}`}>
        {share === null ? '–' : `${Math.floor(share * 100)}%`}
      </span>
    </div>
  );
}

/** Bluetooth: how the hub listens (passive or active), with which adapters and relays, and how many readings it catches. */
export function BluetoothSection() {
  const { ble, pills } = useLive();
  const now = useNow(30_000);
  if (!ble) return null;
  const recording = pills.filter((p) => !p.archived);
  return (
    <section className="panel bt-section">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="bluetooth" /> {t('Bluetooth')}
          </h2>
          <p>{t('How the hub listens for your pills, and how many of their readings it catches.')}</p>
        </div>
        {ble.state === 'scanning' && ble.mode && (
          <span className={`chip ${ble.mode === 'passive' ? 'success' : 'warning'}`}>
            {ble.mode === 'passive' ? t('Passive') : t('Active')}
          </span>
        )}
      </div>

      <dl className="kv">
        <dt>{t('Listening')}</dt>
        <dd>
          <ModeLine ble={ble} />
          {ble.state === 'scanning' && ble.mode === 'active' && ble.modeReason && (
            <span className="bt-reason">{t('Why: {reason}', { reason: ble.modeReason })}</span>
          )}
        </dd>
        <dt>{t('Adapters')}</dt>
        <dd>{ble.adapters.length ? ble.adapters.join(', ') : '–'}</dd>
        <dt>{t('Last pill heard')}</dt>
        <dd>{timeAgo(ble.lastAdvertAt, now)}</dd>
        {ble.lastResetAt ? (
          <>
            <dt>{t('Last reset')}</dt>
            <dd>{t('{ago}: Bluetooth seemed stuck, so the hub switched it off and on', { ago: timeAgo(ble.lastResetAt, now) })}</dd>
          </>
        ) : null}
      </dl>

      <h3 className="bt-heading">{t('Relays')}</h3>
      {ble.relays.length === 0 ? (
        <p className="hint">
          {t('None. An ESP32 near your fermenters can pass on what it hears to the hub.')}{' '}
          <a href={RELAY_GUIDE} target="_blank" rel="noreferrer">
            {t('How to set one up')}
          </a>
        </p>
      ) : (
        <div className="list">
          {ble.relays.map((r) => (
            <div key={r.name} className="list-item">
              <span className={`status-dot${now - r.lastAt < 15 * 60_000 ? ' on' : ''}`} />
              <div className="grow">
                <h4>{r.name}</h4>
                <p>
                  {t('Last heard {ago}', { ago: timeAgo(r.lastAt, now) })} · {tp(r.adverts, '{count} advert', '{count} adverts')}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {recording.length > 0 && (
        <>
          <h3 className="bt-heading">{t('Readings caught')}</h3>
          <p className="hint">{t('Stored readings against how many each pill should have sent, going by its interval.')}</p>
          <div className="list">
            {recording.map((p) => (
              <CaughtRow key={p.id} pill={p} now={now} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
