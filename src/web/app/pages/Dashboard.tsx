import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { plausibleGravity, type NearbyPill, type Pill } from '@rapthooker/shared';
import { api, errorText } from '../api';
import { useLive } from '../live';
import { useUnits } from '../units';
import { useHistory, useRecentRange } from '../hooks';
import { href, navigate } from '../router';
import { fixed, signalQuality, timeAgo, timeUntil, useNow } from '../format';
import { t, tp } from '../i18n';
import { Trans } from '../i18n/Trans';
import { applyOrder, fullOrder, sameOrder, sortByOrder } from '../order';
import { parseFlag, serializeFlag, useStored } from '../storage';
import { Icon } from '../components/Icon';
import { PillFigure } from '../components/PillFigure';
import { Sparkline } from '../components/Sparkline';
import { FermentBar } from '../components/Ferment';
import { BatteryBar, SignalBars } from '../components/ui';
import { PinNotice } from './settings/OwnerSection';
import { FirstRunGuide, useGuide } from './dashboard/FirstRunGuide';
import { ArrangeList } from './dashboard/ArrangeList';
import { PillRow, pillStatus } from './dashboard/PillRow';
import './dashboard/dashboard.css';

const DAY = 86_400_000;

type View = 'cards' | 'compact';
const parseView = (raw: string | null): View => (raw === 'compact' ? 'compact' : 'cards');

export function BleChip() {
  const { ble, clockSynced } = useLive();
  if (!ble) return null;
  const label =
    ble.state === 'scanning'
      ? t('Listening for pills')
      : ble.state === 'mock'
        ? t('Simulated pills')
        : ble.state === 'starting'
          ? t('Starting Bluetooth')
          : ble.state === 'unavailable'
            ? t('No Bluetooth')
            : t('Bluetooth problem');
  return (
    <div className="chips">
      {!clockSynced && (
        <span className="chip warning" title={t('Readings are held until the clock is set from the network')}>
          <Icon name="clock" size={14} /> {t('Waiting for the clock')}
        </span>
      )}
      <span className={`chip ble-chip ${ble.state}`} title={ble.error ?? undefined}>
        <Icon name="bluetooth" size={14} /> {label}
      </span>
    </div>
  );
}

/** Saves the owner's pill order a moment after the last change (so a run of moves is one request). */
function useOrderSaver(pills: Pill[], onFailed: () => void) {
  const { toast } = useLive();
  const latest = useRef({ pills, toast, onFailed });
  latest.current = { pills, toast, onFailed };
  const pending = useRef<string[] | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const ids = pending.current;
    pending.current = null;
    if (!ids) return;
    const { pills: all, toast: show, onFailed: failed } = latest.current;
    api.reorderPills(fullOrder(ids, all)).catch((err: unknown) => {
      show({ tone: 'error', title: t("Couldn't save the order"), body: errorText(err) });
      failed();
    });
  }, []);

  const save = useCallback(
    (ids: string[]) => {
      pending.current = ids;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 600);
    },
    [flush],
  );

  useEffect(() => flush, [flush]);
  return { save, flush };
}

export function Dashboard() {
  const { pills, nearby, ble, loaded, session, isOwner } = useLive();
  const [view, setView] = useStored('rapthooker.dashboard.view', parseView);
  const [brewingOnly, setBrewingOnly] = useStored('rapthooker.dashboard.brewing', parseFlag, serializeFlag);
  const [arranging, setArranging] = useState(false);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const guide = useGuide();
  const saver = useOrderSaver(pills, () => setLocalOrder(null));

  const active = useMemo(() => pills.filter((p) => !p.archived), [pills]);
  const ordered = useMemo(() => applyOrder(active, localOrder), [active, localOrder]);
  const brewing = active.filter((p) => p.brew).length;
  const shown = brewingOnly && !arranging ? ordered.filter((p) => p.brew) : ordered;

  // The local order only bridges the gap until the hub's order catches up.
  const hubIds = useMemo(() => sortByOrder(active).map((p) => p.id), [active]);
  useEffect(() => {
    if (
      localOrder &&
      !arranging &&
      sameOrder(
        hubIds,
        ordered.map((p) => p.id),
      )
    )
      setLocalOrder(null);
  }, [localOrder, arranging, hubIds, ordered]);

  const changeOrder = (ids: string[], final: boolean) => {
    setLocalOrder(ids);
    if (final) saver.save(ids);
  };
  const doneArranging = () => {
    saver.flush();
    setArranging(false);
  };
  const canArrange = isOwner && active.length > 1;
  if (arranging && !canArrange) setArranging(false);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Your pills')}</h1>
          <p>
            {active.length === 0
              ? t('Live readings from your RAPT Pills, recorded around the clock.')
              : `${tp(active.length, '{count} pill recording', '{count} pills recording')}${brewing ? ` · ${tp(brewing, '{count} brew on the go', '{count} brews on the go')}` : ''}`}
          </p>
        </div>
        <BleChip />
      </div>

      {guide.visible ? <FirstRunGuide onHide={guide.hide} /> : session && !session.pinSet && <PinNotice />}

      {ble && (ble.state === 'error' || ble.state === 'unavailable') && (
        <div className="notice danger">
          <Icon name="alert" />
          <p className="grow">
            <strong>{t("Bluetooth isn't working.")}</strong> {ble.error ?? ''}{' '}
            {t("Readings will be missing until it's back; the hub keeps trying.")}
          </p>
        </div>
      )}

      {nearby.length > 0 && (
        <section className="stack" aria-label={t('Pills nearby')}>
          {nearby.map((n) => (
            <NearbyCard key={n.address} pill={n} />
          ))}
        </section>
      )}

      {!loaded ? (
        <div className="grid cards" aria-busy="true" aria-label={t('Loading pills')}>
          <div className="skeleton" style={{ height: '22rem' }} />
          <div className="skeleton" style={{ height: '22rem' }} />
        </div>
      ) : active.length === 0 ? (
        nearby.length === 0 && !guide.visible && <EmptyState />
      ) : (
        <>
          <div className="dash-toolbar">
            {!arranging && (
              <>
                <div className="segmented" role="group" aria-label={t('Layout')}>
                  <button
                    type="button"
                    className={view === 'cards' ? 'on' : ''}
                    aria-pressed={view === 'cards'}
                    onClick={() => setView('cards')}
                  >
                    <Icon name="grid" size={14} /> {t('Cards')}
                  </button>
                  <button
                    type="button"
                    className={view === 'compact' ? 'on' : ''}
                    aria-pressed={view === 'compact'}
                    onClick={() => setView('compact')}
                  >
                    <Icon name="rows" size={14} /> {t('Compact')}
                  </button>
                </div>
                <button
                  type="button"
                  className={`chip toggle${brewingOnly ? ' on' : ''}`}
                  aria-pressed={brewingOnly}
                  onClick={() => setBrewingOnly(!brewingOnly)}
                >
                  <Icon name={brewingOnly ? 'check' : 'beer'} size={14} /> {t('Brewing only')}
                </button>
              </>
            )}
            {arranging && (
              <p className="muted small grow">{t("Drag the pills, or use the arrows, to set their order. It's saved for everyone.")}</p>
            )}
            <span className="spacer" />
            {canArrange && (
              <button
                type="button"
                className={`btn small${arranging ? ' primary' : ''}`}
                aria-pressed={arranging}
                onClick={() => (arranging ? doneArranging() : setArranging(true))}
              >
                <Icon name={arranging ? 'check' : 'grip'} size={16} /> {arranging ? t('Done') : t('Arrange')}
              </button>
            )}
            {!arranging && (
              <a className="btn small" href="#/kiosk" title={t('Big readings for a spare screen')}>
                <Icon name="tv" size={16} /> {t('TV mode')}
              </a>
            )}
          </div>

          {arranging ? (
            <ArrangeList pills={ordered} onChange={changeOrder} />
          ) : shown.length === 0 ? (
            <div className="panel empty compact-empty">
              <h2>{t('No brews on the go')}</h2>
              <p>{t("Start a brew from a pill's page to track it here.")}</p>
              <button type="button" className="btn" onClick={() => setBrewingOnly(false)}>
                {t('Show all pills')}
              </button>
            </div>
          ) : view === 'compact' ? (
            <ul className="pill-rows" aria-label={t('Pills')}>
              {shown.map((p) => (
                <PillRow key={p.id} pill={p} />
              ))}
            </ul>
          ) : (
            <div className="grid cards">
              {shown.map((p) => (
                <PillCard key={p.id} pill={p} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="panel empty">
      <img className="art" src="/icons/icon.svg" alt="" />
      <h2>{t('Listening for RAPT Pills…')}</h2>
      <p>
        <Trans
          text={t(
            "Put your pill in {mode} (RAPT app → your pill → Connect → Setup → Telemetry via Bluetooth) and keep it within range of this hub. It'll pop up here so you can add it.",
          )}
          values={{ mode: <strong>{t('Bluetooth mode')}</strong> }}
        />
      </p>
      <p className="small muted">{t('Pills only send every few minutes, so it can take a little while to appear.')}</p>
    </div>
  );
}

function NearbyCard({ pill }: { pill: NearbyPill }) {
  const { isOwner, toast, upsertPill } = useLive();
  const u = useUnits();
  const now = useNow(10_000);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const nearbySignal = signalQuality(pill.rssi);
  const add = async () => {
    setBusy(true);
    try {
      const added = await api.adopt(pill.address, name.trim() || undefined);
      upsertPill(added);
      toast({ tone: 'success', title: t('{name} added', { name: added.name }), body: t('Recording has started.') });
      navigate(href.pill(added.id));
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't add the pill"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel nearby">
      <div className="radar" aria-hidden="true">
        <Icon name="bluetooth" size={20} />
      </div>
      <div className="info">
        <h2>{t('Found a RAPT Pill nearby')}</h2>
        <div className="small muted num">
          {pill.raptId} · {pill.latest ? `${u.gravityText(pill.latest.gravity)} · ${u.tempText(pill.latest.temperature)} · ` : ''}
          {nearbySignal
            ? t('Signal: {quality} ({rssi} dBm)', { quality: nearbySignal.label, rssi: nearbySignal.rssi })
            : t('Signal unknown')}{' '}
          · {t('heard {ago}', { ago: timeAgo(pill.lastHeardAt, now) })}
        </div>
      </div>
      {isOwner ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            className="input"
            style={{ width: '12rem' }}
            aria-label={t('Name for the pill {id} (optional)', { id: pill.raptId })}
            placeholder={t('Name it (optional)')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
          />
          <button type="submit" className="btn primary" disabled={busy}>
            <Icon name="plus" /> {t('Add pill')}
          </button>
          <button
            type="button"
            className="btn ghost"
            title={t('Not yours? Hide it')}
            onClick={() =>
              api.ignoreNearby(pill.address, true).catch((e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }))
            }
          >
            {t('Ignore')}
          </button>
        </form>
      ) : (
        <a className="btn" href="#/settings">
          <Icon name="lock" /> {t('Sign in to add it')}
        </a>
      )}
    </div>
  );
}

export function PillCard({ pill }: { pill: Pill }) {
  const u = useUnits();
  const { cachedAt } = useLive();
  const now = useNow(15_000);
  const range = useRecentRange(DAY);
  const { history } = useHistory(pill.id, range, 160);
  const r = pill.live.latest;
  const g = u.gravityParts(r?.gravity);
  const v = r?.velocity ?? null;
  const signal = signalQuality(pill.live.rssi);
  const next = pill.live.lastReadingAt && pill.live.intervalSec ? pill.live.lastReadingAt + pill.live.intervalSec * 1000 : null;
  const status = pillStatus(pill, cachedAt);

  return (
    <article className={`panel pill-card${pill.live.online ? '' : ' offline'}`} style={{ '--pill': pill.color } as CSSProperties}>
      <div className="pill-card-head">
        <PillFigure color={pill.color} tilt={r?.tilt} size={46} offline={!pill.live.online} decorative />
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
        {pill.brew ? <span className="chip brew">{t('Brewing')}</span> : <span className="chip">{t('Idle')}</span>}
      </div>
      {r && !plausibleGravity(r.gravity) && (
        <div
          className="chip warning"
          style={{ alignSelf: 'flex-start', position: 'relative' }}
          title={t("Out of liquid a pill reports a gravity worked out from however it's lying")}
        >
          <Icon name="alert" size={12} /> {t('Gravity looks wrong: is the pill floating?')}
        </div>
      )}

      <div className="big-readings">
        <div>
          <div className="reading-label">{t('Gravity')}</div>
          <div className="gravity-value">
            {g.main}
            <span className="tail">{g.tail}</span>
            <span className="unit">{g.unit}</span>
          </div>
          <div className={`trend${v === null ? '' : v < -0.3 ? ' down' : v > 0.3 ? ' up' : ''}`}>
            <Icon name={v !== null && v > 0 ? 'up' : 'down'} size={14} />
            {v === null ? t('Velocity not ready yet') : t('{n} pts/day', { n: `${v > 0 ? '+' : ''}${fixed(v, 1)}` })}
          </div>
        </div>
        <div>
          <div className="reading-label" style={{ textAlign: 'right' }}>
            {t('Temperature')}
          </div>
          <div className="temp-value">{r ? u.tempText(r.temperature) : '–'}</div>
        </div>
      </div>

      {history && history.ts.length > 1 && (
        <Sparkline
          ts={history.ts}
          values={history.gravity}
          secondary={history.temperature}
          color={pill.color}
          from={range.from}
          to={Math.max(history.to, Date.now())}
          minSpan={0.004}
          secondaryMinSpan={3}
        />
      )}

      {pill.brew && <FermentBar brew={pill.brew} compact />}

      <div className="mini-stats">
        <div className="mini-stat">
          <span className="k">
            <Icon name="battery" size={12} /> {t('Battery')}
          </span>
          {r ? `${Math.round(r.battery)}%` : '–'}
          <BatteryBar percent={r?.battery} />
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
            <Icon name="tilt" size={12} /> {t('Tilt')}
          </span>
          {r?.tilt != null ? `${fixed(r.tilt, 1)}°` : '–'}
        </div>
        <div className="mini-stat">
          <span className="k">
            {/* i18n: when the next reading is due */}
            <Icon name="clock" size={12} /> {t('Next')}
          </span>
          {pill.live.online && !cachedAt ? timeUntil(next, now) : '–'}
        </div>
      </div>
    </article>
  );
}
