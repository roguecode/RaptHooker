import { useCallback, useMemo, useRef, useState } from 'react';
import { fillHistory, windowsIn, type Pill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { historyGapMs, useHistoryRange, useZoomableHistory } from '../../hooks';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { dateTime } from '../../format';
import { Icon } from '../../components/Icon';
import { CollapsiblePanel, usePanelOpen } from '../../components/CollapsiblePanel';
import { t } from '../../i18n';
import { Chart, SERIES, type ChartHandle, type SeriesKey } from '../../components/Chart';
import { OverviewStrip } from '../../components/OverviewStrip';
import { RangePicker } from '../../components/RangePicker';
import { alertAnnotations, brewAnnotations } from '../../components/annotations';
import { AlertsToggle, useAlertEvents, useShowAlerts } from '../../components/ChartAlerts';
import { clampWindow, contextWindow, isZoomed, pngFileName, SMOOTHING_STEPS_MS, type TimeWindow } from '../../components/chartMath';
import { ExcludeRangeButton, ExclusionsToggle, useRemoveExclusion, useShowExclusions } from '../../components/ExclusionControls';
import { SmoothingStepper, useChartSmoothing } from '../../components/ChartSmoothing';
import { kegName } from '../devices/keg';
import './pill.css';

const SERIES_KEY = 'rapthooker.series';
/** A thermometer only has these, and keeps its own choice of them. */
const THERMOMETER_SERIES: readonly SeriesKey[] = ['temperature', 'rssi'];
const THERMOMETER_SERIES_KEY = 'rapthooker.series.thermometer';
/** A Laser Level likewise. */
const LASER_SERIES: readonly SeriesKey[] = ['volume', 'temperature', 'battery', 'rssi'];
const LASER_SERIES_KEY = 'rapthooker.series.laser';
/** What a hydrometer can chart (a Laser Level's volume isn't one). */
const HYDROMETER_SERIES: readonly SeriesKey[] = SERIES.map((s) => s.key).filter((k) => k !== 'volume');

/** The lines a kind of device can have, where its choice of them is kept, and what's shown at first. */
const seriesFor = (kind: Pill['kind']): { offered: readonly SeriesKey[]; key: string; fallback: SeriesKey[] } =>
  kind === 'thermometer'
    ? { offered: THERMOMETER_SERIES, key: THERMOMETER_SERIES_KEY, fallback: ['temperature'] }
    : kind === 'laser-level'
      ? { offered: LASER_SERIES, key: LASER_SERIES_KEY, fallback: ['volume'] }
      : kind === 'tilt'
        ? {
            offered: HYDROMETER_SERIES.filter((k) => k !== 'battery' && k !== 'tilt'),
            key: SERIES_KEY,
            fallback: ['gravity', 'temperature'],
          }
        : { offered: HYDROMETER_SERIES, key: SERIES_KEY, fallback: ['gravity', 'temperature'] };

const loadSeries = (kind: Pill['kind']): SeriesKey[] => {
  const { offered, key, fallback } = seriesFor(kind);
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? 'null') as SeriesKey[] | null;
    const allowed = s?.filter((k) => offered.includes(k));
    return Array.isArray(allowed) && allowed.length ? allowed : fallback;
  } catch {
    return fallback;
  }
};

export function HistoryPanel({ pill }: { pill: Pill }) {
  const { isOwner, toast } = useLive();
  const u = useUnits();
  const [open, toggleOpen] = usePanelOpen('pill.history', true);
  const brew = pill.brew;
  const keg = pill.keg ?? null;
  const thermometer = pill.kind === 'thermometer';
  const lines = seriesFor(pill.kind);
  const firstAt = Math.min(pill.live.firstReadingAt ?? pill.createdAt, pill.createdAt);
  const { preset, setPreset, custom, setCustom, range } = useHistoryRange({
    initial: brew ? 'brew' : keg ? 'keg' : '24h',
    firstAt,
    brewStart: brew?.startedAt ?? null,
    kegStart: keg?.keggedAt ?? null,
  });
  const [view, setView] = useState<TimeWindow | null>(null);
  const [series, setSeries] = useState<SeriesKey[]>(() => loadSeries(pill.kind));
  const [exporting, setExporting] = useState(false);
  const chart = useRef<ChartHandle>(null);
  const offered = SERIES.filter((s) => lines.offered.includes(s.key));

  // A brew started (or a beer kegged up) while the page is open is shown from its start.
  const [shownBrew, setShownBrew] = useState(brew?.id ?? null);
  if ((brew?.id ?? null) !== shownBrew) {
    setShownBrew(brew?.id ?? null);
    if (brew) {
      setView(null);
      setPreset('brew');
    }
  }
  const [shownKeg, setShownKeg] = useState(keg?.id ?? null);
  if ((keg?.id ?? null) !== shownKeg) {
    setShownKeg(keg?.id ?? null);
    if (keg) {
      setView(null);
      setPreset('keg');
    }
  }

  const gapMs = historyGapMs(pill.live.intervalSec);
  const m = pill.model;
  const [showExclusions, setShowExclusions] = useShowExclusions();
  // With exclusions shown, the hub leaves the excluded readings out of averages, smoothing and velocity too.
  const leaveOut = showExclusions && (pill.exclusions?.length ?? 0) > 0;
  const reloadKey = [
    pill.offsets.gravity,
    pill.offsets.temperature,
    m.gravitySource,
    (m.tiltPoly ?? []).join(','),
    m.velocitySource,
    m.velocityHours,
    m.smoothing,
    leaveOut ? (pill.exclusions ?? []).map((e) => `${e.from}-${e.to}`).join(',') : '',
  ].join('|');
  const { overview, history, bounds, loading, error } = useZoomableHistory(open ? pill.id : null, range, view, {
    points: 1500,
    gapMs,
    reloadKey,
    exclude: leaveOut,
  });
  const win = view ? clampWindow(view, bounds) : bounds;
  const zoomed = view !== null && isZoomed(win, bounds);

  const [showAlerts, setShowAlerts] = useShowAlerts();
  const alertEvents = useAlertEvents(open ? pill.id : null);
  const alertsHere = alertEvents.some((e) => e.at >= bounds.from && e.at <= bounds.to);
  const annotations = useMemo(
    () => (showAlerts && alertEvents.length ? [...brewAnnotations(brew), ...alertAnnotations(alertEvents)] : brewAnnotations(brew)),
    [brew, showAlerts, alertEvents],
  );
  const [smoothing, setSmoothing] = useChartSmoothing();

  const removeExclusion = useRemoveExclusion(pill);
  const exclusionsHere = windowsIn(pill.exclusions, bounds);
  const excluding = showExclusions && exclusionsHere.length > 0;
  const exclusionKey = excluding ? exclusionsHere.map((e) => `${e.from}-${e.to}`).join(',') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const overviewShown = useMemo(() => (excluding ? fillHistory(overview, exclusionsHere) : overview), [overview, exclusionKey]);

  const onZoom = useCallback(
    (from: number, to: number) => {
      const next = { from, to };
      setView(isZoomed(next, bounds) ? next : null);
    },
    [bounds],
  );
  const resetZoom = useCallback(() => setView(null), []);

  const toggle = (k: SeriesKey) => {
    const next = series.includes(k) ? series.filter((s) => s !== k) : [...series, k];
    const ordered = SERIES.map((s) => s.key).filter((s) => next.includes(s));
    setSeries(ordered);
    localStorage.setItem(lines.key, JSON.stringify(ordered));
  };

  const exportPng = async () => {
    setExporting(true);
    try {
      await chart.current?.exportPng({
        title: brew ? `${pill.name} · ${brew.name}` : keg ? `${pill.name} · ${kegName(keg)}` : pill.name,
        subtitle: `${dateTime(win.from)} – ${dateTime(win.to)}`,
        fileName: pngFileName(pill.name, Date.now()),
      });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save the image"), body: errorText(err) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <CollapsiblePanel
      open={open}
      onToggle={toggleOpen}
      label={t('History')}
      className="pill-history"
      title={
        <>
          <Icon name="activity" /> {t('History')}
        </>
      }
      lead={open && t('Drag across the chart or pinch to zoom; double-tap to see it all. Gaps are times nothing was recorded.')}
      actions={
        <>
          {open && (
            <button type="button" className="btn small" onClick={() => void exportPng()} disabled={exporting || !history?.ts.length}>
              <Icon name="download" size={16} /> PNG
            </button>
          )}
          <a className="btn small" href={api.pillCsvUrl(pill.id)} download>
            <Icon name="download" size={16} /> CSV
          </a>
        </>
      }
    >
      <div className="chart-toolbar">
        <RangePicker
          preset={preset}
          custom={custom}
          hasBrew={!!brew}
          hasKeg={!!keg}
          onPreset={(p) => {
            setView(null);
            setPreset(p);
          }}
          onCustom={(w) => {
            setView(null);
            setCustom(w);
          }}
        />
      </div>
      {error && !history && (
        <div className="notice danger" role="alert">
          <Icon name="alert" />
          <p>{t("Couldn't load the history: {error}", { error })}</p>
        </div>
      )}
      <div className="pill-chart" style={{ opacity: loading && !history ? 0.5 : 1 }}>
        <Chart
          ref={chart}
          history={history}
          series={series}
          from={win.from}
          to={win.to}
          bounds={bounds}
          gravityColor={pill.color}
          onZoom={onZoom}
          onResetZoom={resetZoom}
          targetFg={brew?.targetFg}
          og={brew ? brew.stats.og : null}
          annotations={annotations}
          smoothMs={SMOOTHING_STEPS_MS[smoothing]}
          exclusions={excluding ? exclusionsHere : undefined}
          onRemoveExclusion={isOwner ? removeExclusion : undefined}
          label={t('History of {name}', { name: pill.name })}
          vessel={pill.vessel}
          volumeScale={pill.kind === 'laser-level' ? u.volumeScale(pill.servingUnit) : undefined}
        />
        {(overview?.ts.length ?? 0) > 1 && (
          <OverviewStrip
            history={overviewShown}
            bounds={bounds}
            view={view}
            color={pill.color}
            tempOnly={thermometer || pill.kind === 'laser-level'}
            onChange={(w) => onZoom(w.from, w.to)}
          />
        )}
      </div>
      <div className="chart-controls">
        {zoomed && (
          <button type="button" className="chip on" onClick={resetZoom}>
            <Icon name="x" size={12} /> {t('Show it all')}
          </button>
        )}
        {zoomed && isOwner && (
          <ExcludeRangeButton
            pill={pill}
            range={win}
            onExcluded={(r) => {
              setShowExclusions(true);
              setView(contextWindow(r, bounds));
            }}
          />
        )}
        <div className="chips" role="group" aria-label={t('Lines on the chart')}>
          {offered.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`chip${series.includes(s.key) ? ' on' : ''}`}
              aria-pressed={series.includes(s.key)}
              onClick={() => toggle(s.key)}
            >
              <span className="swatch" style={{ background: s.key === 'gravity' || s.key === 'volume' ? pill.color : `var(${s.color})` }} />{' '}
              {t(s.label)}
            </button>
          ))}
        </div>
        <span className="chip-option">
          <span className="chips-divider" aria-hidden="true" />
          {exclusionsHere.length > 0 && <ExclusionsToggle on={showExclusions} onChange={setShowExclusions} />}
          {alertsHere && <AlertsToggle on={showAlerts} onChange={setShowAlerts} />}
          <SmoothingStepper step={smoothing} onChange={setSmoothing} />
        </span>
      </div>
    </CollapsiblePanel>
  );
}
