import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { plausibleGravity, type Pill } from '@rapthooker/shared';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { historyGapMs, useHistory, useRecentRange } from '../../hooks';
import { navigate } from '../../router';
import { fixed, signalQuality, timeAgo, timeOnly, useNow } from '../../format';
import { t } from '../../i18n';
import { sortByOrder } from '../../order';
import { useStored } from '../../storage';
import { Icon } from '../../components/Icon';
import { Sparkline } from '../../components/Sparkline';
import { rangeOf } from '../dashboard/ThermometerCard';
import { brewDay, kioskLayout, pageItems, parseKioskSettings, ROTATE_SECONDS, serializeKioskSettings } from './layout';
import './kiosk.css';

const DAY = 86_400_000;
const IDLE_MS = 3500;

type WakeState = 'pending' | 'active' | 'unsupported' | 'failed';

/** Keeps the screen on while TV mode is open (the lock is dropped whenever the page is hidden, so it's taken again). */
function useWakeLock(): WakeState {
  const [state, setState] = useState<WakeState>('pending');
  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
    if (!wakeLock) {
      setState('unsupported');
      return;
    }
    let lock: WakeLockSentinel | null = null;
    let disposed = false;
    let asking = false;
    const acquire = async () => {
      if (disposed || asking || lock || document.visibilityState !== 'visible') return;
      asking = true;
      try {
        const got = await wakeLock.request('screen');
        if (disposed) {
          void got.release().catch(() => undefined);
          return;
        }
        lock = got;
        setState('active');
        got.addEventListener('release', () => {
          lock = null;
          if (!disposed) setState('pending');
        });
      } catch (err) {
        console.warn('wake lock', err);
        if (!disposed) setState('failed');
      } finally {
        asking = false;
      }
    };
    const onVisible = () => void acquire();
    document.addEventListener('visibilitychange', onVisible);
    // Some browsers only grant it after a tap.
    window.addEventListener('pointerdown', onVisible);
    void acquire();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pointerdown', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, []);
  return state;
}

/** True after a few seconds without the mouse, touch or keyboard. */
function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), ms);
    };
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    wake();
    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, wake);
    };
  }, [ms]);
  return idle;
}

function useFullscreen() {
  const [on, setOn] = useState(() => Boolean(document.fullscreenElement));
  useEffect(() => {
    const update = () => setOn(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  const root = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
  const supported = Boolean(document.fullscreenEnabled && root.requestFullscreen);
  const toggle = () => {
    const done = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.();
    void done?.catch((err: unknown) => console.warn('fullscreen', err));
  };
  return { on, supported, toggle };
}

/** The size of an element, kept up to date. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) => (Math.abs(s.width - width) < 1 && Math.abs(s.height - height) < 1 ? s : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Full-screen big readings for a spare screen or TV, rotating through the pills when they don't all fit. */
export function Kiosk({ offline }: { offline: boolean }) {
  const { pills, hub, cachedAt, loaded } = useLive();
  const [settings, setSettings] = useStored('rapthooker.kiosk', parseKioskSettings, serializeKioskSettings);
  const active = useMemo(() => sortByOrder(pills.filter((p) => !p.archived)), [pills]);
  const [gridRef, size] = useSize<HTMLDivElement>();
  const layout = kioskLayout(size.width, size.height, active.length, { max: settings.one ? 1 : undefined });
  const [page, setPage] = useState(0);
  const idle = useIdle(IDLE_MS);
  const wake = useWakeLock();
  const fullscreen = useFullscreen();
  const now = useNow(10_000);
  const titleId = useId();

  useEffect(() => {
    if (layout.pages <= 1) return;
    const timer = window.setInterval(() => setPage((p) => p + 1), settings.seconds * 1000);
    return () => window.clearInterval(timer);
  }, [layout.pages, settings.seconds]);

  const exit = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    navigate('#/');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) navigate('#/');
      if (e.key === 'ArrowRight') setPage((p) => p + 1);
      if (e.key === 'ArrowLeft') setPage((p) => p - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pageIndex = ((page % layout.pages) + layout.pages) % layout.pages;
  const onScreen = pageItems(active, pageIndex, layout.perPage);
  const clock = timeOnly(now);

  return (
    <main className={`kiosk${idle ? ' idle' : ''}`} aria-labelledby={titleId}>
      <div className="ambient" aria-hidden="true" />
      <header className="kiosk-head">
        <h1 id={titleId} className="kiosk-brand">
          <img src="/icons/icon.svg" alt="" />
          <span className="kiosk-name">{hub.name}</span>
          <span className="sr-only"> {t('TV mode')}</span>
        </h1>
        {offline && (
          <span className="chip warning">
            <Icon name="wifiOff" size={14} /> {cachedAt ? t('Offline: data from {ago}', { ago: timeAgo(cachedAt, now) }) : t('Offline')}
          </span>
        )}
        <span className="spacer" />
        {layout.pages > 1 && (
          <span className="kiosk-dots" role="img" aria-label={t('Screen {n} of {total}', { n: pageIndex + 1, total: layout.pages })}>
            {Array.from({ length: layout.pages }, (_, i) => (
              <i key={i} className={i === pageIndex ? 'on' : ''} />
            ))}
          </span>
        )}
        <time className="kiosk-clock">{clock}</time>
      </header>

      <div className="kiosk-grid-wrap" ref={gridRef}>
        {!loaded ? null : active.length === 0 ? (
          <div className="kiosk-empty">
            <h2>{t('No pills yet')}</h2>
            <p>{t('Add a pill on the dashboard and its readings show up here.')}</p>
          </div>
        ) : (
          <div
            key={`${pageIndex}/${layout.perPage}`}
            className="kiosk-grid"
            style={{
              gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
            }}
          >
            {onScreen.map((p) => (
              <KioskTile key={p.id} pill={p} now={now} stale={cachedAt !== null} />
            ))}
          </div>
        )}
      </div>

      <div className="kiosk-controls" role="group" aria-label={t('TV mode controls')}>
        <button type="button" className="btn" onClick={exit}>
          <Icon name="x" /> {t('Exit TV mode')}
        </button>
        {fullscreen.supported && (
          <button type="button" className="btn" onClick={fullscreen.toggle} aria-pressed={fullscreen.on}>
            <Icon name={fullscreen.on ? 'minimize' : 'maximize'} /> {fullscreen.on ? t('Leave full screen') : t('Full screen')}
          </button>
        )}
        <div className="segmented" role="group" aria-label={t('Pills per screen')}>
          <button
            type="button"
            className={settings.one ? '' : 'on'}
            aria-pressed={!settings.one}
            onClick={() => setSettings({ ...settings, one: false })}
          >
            {t('All that fit')}
          </button>
          <button
            type="button"
            className={settings.one ? 'on' : ''}
            aria-pressed={settings.one}
            onClick={() => setSettings({ ...settings, one: true })}
          >
            {t('One at a time')}
          </button>
        </div>
        <label className="kiosk-rotate">
          <span>{t('Next screen every')}</span>
          <select
            className="select"
            value={settings.seconds}
            onChange={(e) => setSettings({ ...settings, seconds: Number(e.target.value) })}
          >
            {ROTATE_SECONDS.map((s) => (
              <option key={s} value={s}>
                {t('{n} s', { n: s })}
              </option>
            ))}
          </select>
        </label>
        {(wake === 'unsupported' || wake === 'failed') && (
          <p className="kiosk-hint">
            <Icon name="info" size={16} />
            {wake === 'unsupported'
              ? t(
                  "This browser can't keep the screen on from here (it needs a secure https:// address, such as through Tailscale). Turn off screen sleep in the device's settings instead.",
                )
              : t("Couldn't keep the screen on. Tap the screen to try again, or turn off screen sleep in the device's settings.")}
          </p>
        )}
      </div>
    </main>
  );
}

function KioskTile({ pill, now, stale }: { pill: Pill; now: number; stale: boolean }) {
  const u = useUnits();
  const range = useRecentRange(DAY);
  const { history } = useHistory(pill.id, range, 160, historyGapMs(pill.live.intervalSec));
  const r = pill.live.latest;
  const g = u.gravityParts(r?.gravity);
  const v = r?.velocity ?? null;
  const brew = pill.brew;
  const abv = brew?.stats.abv ?? null;
  const seen = pill.live.lastHeardAt ?? pill.live.lastReadingAt;
  const online = pill.live.online && !stale;
  const nameId = useId();
  const thermometer = pill.kind === 'thermometer';
  const day = useMemo(() => (thermometer ? rangeOf(history?.temperature) : null), [thermometer, history]);
  const signal = signalQuality(pill.live.rssi);

  return (
    <article
      className={`kiosk-tile${pill.live.online ? '' : ' offline'}`}
      style={{ '--pill': pill.color } as CSSProperties}
      aria-labelledby={nameId}
    >
      <div className="kt-head">
        <h2 id={nameId}>{pill.name}</h2>
        <span className="kt-brew">
          {thermometer ? (
            t('Thermometer')
          ) : brew ? (
            <>
              {brew.name} · <strong>{t('Day {n}', { n: brewDay(brew.startedAt, now) })}</strong>
            </>
          ) : (
            t('No brew running')
          )}
        </span>
      </div>

      <div className="kt-main">
        {thermometer ? (
          <div className="kt-gravity num">
            {r ? fixed(u.tempValue(r.temperature), 1) : '–'}
            <span className="unit">{u.tempLabel}</span>
          </div>
        ) : (
          <>
            <div className="kt-gravity num">
              {g.main}
              <span className="tail">{g.tail}</span>
              <span className="unit">{g.unit}</span>
            </div>
            <div className="kt-temp num">{r ? u.tempText(r.temperature) : '–'}</div>
          </>
        )}
      </div>
      {r && r.gravity !== null && !plausibleGravity(r.gravity) && (
        <div className="kt-warn">
          <Icon name="alert" size={16} /> {t('Gravity looks wrong: is the pill floating?')}
        </div>
      )}

      <div className="kt-spark">
        {history &&
          history.ts.length > 1 &&
          (thermometer ? (
            <Sparkline
              ts={history.ts}
              values={history.temperature}
              color={pill.color}
              from={range.from}
              to={Math.max(history.to, Date.now())}
              minSpan={2}
            />
          ) : (
            <Sparkline
              ts={history.ts}
              values={history.gravity}
              skip={history.implausible}
              secondary={history.temperature}
              color={pill.color}
              from={range.from}
              to={Math.max(history.to, Date.now())}
              minSpan={0.004}
              secondaryMinSpan={3}
            />
          ))}
      </div>

      <dl className="kt-stats">
        {thermometer ? (
          <>
            <div>
              <dt>{t('Last 24 h')}</dt>
              <dd className="num">{day ? `${fixed(u.tempValue(day.min), 1)}–${fixed(u.tempValue(day.max), 1)}` : '–'}</dd>
            </div>
            <div>
              <dt>{t('Signal')}</dt>
              <dd>{signal ? signal.label : '–'}</dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>ABV</dt>
              <dd className="num">{abv === null ? '–' : `${fixed(abv, 1)}%`}</dd>
            </div>
            <div>
              <dt>{t('Velocity')}</dt>
              <dd className="num">
                {v === null ? '–' : `${v > 0 ? '+' : ''}${fixed(v, 1)}`}
                {v !== null && <small> {t('pts/day')}</small>}
              </dd>
            </div>
            <div>
              <dt>{t('Battery')}</dt>
              <dd className={`num${r?.battery != null && r.battery < 20 ? ' low' : ''}`}>
                {r?.battery != null ? `${Math.round(r.battery)}%` : '–'}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>{t('Last seen')}</dt>
          <dd>
            <span className={`status-dot${online ? ' on' : ''}`} aria-hidden="true" /> {timeAgo(seen, now)}
          </dd>
        </div>
      </dl>
    </article>
  );
}
