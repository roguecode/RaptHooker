import { useCallback, useMemo, useRef, useState } from 'react';
import type { Pill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { historyGapMs, useHistoryRange, useZoomableHistory } from '../../hooks';
import { useLive } from '../../live';
import { dateTime } from '../../format';
import { Icon } from '../../components/Icon';
import { CollapsiblePanel, usePanelOpen } from '../../components/CollapsiblePanel';
import { t } from '../../i18n';
import { Chart, SERIES, useLineColors, type ChartHandle, type SeriesKey } from '../../components/Chart';
import { OverviewStrip } from '../../components/OverviewStrip';
import { RangePicker } from '../../components/RangePicker';
import { brewAnnotations } from '../../components/annotations';
import { clampWindow, isZoomed, pngFileName, SMOOTHING_STEPS_MS, type TimeWindow } from '../../components/chartMath';
import { contextWindow, fillHistory, windowsIn } from '../../components/exclusions';
import { ExcludeRangeButton, ExclusionsToggle, useRemoveExclusion, useShowExclusions } from '../../components/ExclusionControls';
import { SmoothingStepper, useChartSmoothing } from '../../components/ChartSmoothing';
import { useScaleRanges } from '../../components/chartScales';
import './pill.css';

const SERIES_KEY = 'rapthooker.series';
/** A thermometer only has these, and keeps its own choice of them. */
const THERMOMETER_SERIES: readonly SeriesKey[] = ['temperature', 'rssi'];
const THERMOMETER_SERIES_KEY = 'rapthooker.series.thermometer';

const loadSeries = (thermometer: boolean): SeriesKey[] => {
  const fallback: SeriesKey[] = thermometer ? ['temperature'] : ['gravity', 'temperature'];
  try {
    const s = JSON.parse(localStorage.getItem(thermometer ? THERMOMETER_SERIES_KEY : SERIES_KEY) ?? 'null') as SeriesKey[] | null;
    const allowed = s?.filter((k) => SERIES.some((x) => x.key === k) && (!thermometer || THERMOMETER_SERIES.includes(k)));
    return Array.isArray(allowed) && allowed.length ? allowed : fallback;
  } catch {
    return fallback;
  }
};

export function HistoryPanel({ pill }: { pill: Pill }) {
  const { isOwner, toast } = useLive();
  const [open, toggleOpen] = usePanelOpen('pill.history', true);
  const brew = pill.brew;
  const thermometer = pill.kind === 'thermometer';
  const firstAt = Math.min(pill.live.firstReadingAt ?? pill.createdAt, pill.createdAt);
  const { preset, setPreset, custom, setCustom, range } = useHistoryRange({
    initial: brew ? 'brew' : '24h',
    firstAt,
    brewStart: brew?.startedAt ?? null,
  });
  const [view, setView] = useState<TimeWindow | null>(null);
  const [series, setSeries] = useState<SeriesKey[]>(() => loadSeries(thermometer));
  const lineColors = useLineColors(pill.color, series.includes('gravity'));
  const [exporting, setExporting] = useState(false);
  const chart = useRef<ChartHandle>(null);
  const offered = thermometer ? SERIES.filter((s) => THERMOMETER_SERIES.includes(s.key)) : SERIES;

  // A brew started while the page is open is shown from its start.
  const [shownBrew, setShownBrew] = useState(brew?.id ?? null);
  if ((brew?.id ?? null) !== shownBrew) {
    setShownBrew(brew?.id ?? null);
    if (brew) {
      setView(null);
      setPreset('brew');
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

  const annotations = useMemo(() => brewAnnotations(brew), [brew]);
  const [smoothing, setSmoothing] = useChartSmoothing();
  const [scaleRanges, setScaleRanges] = useScaleRanges(`pill.${pill.id}`);

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
    localStorage.setItem(thermometer ? THERMOMETER_SERIES_KEY : SERIES_KEY, JSON.stringify(ordered));
  };

  const exportPng = async () => {
    setExporting(true);
    try {
      await chart.current?.exportPng({
        title: brew ? `${pill.name} · ${brew.name}` : pill.name,
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
          scaleRanges={scaleRanges}
          onScaleRangesChange={setScaleRanges}
          label={t('History of {name}', { name: pill.name })}
        />
        {(overview?.ts.length ?? 0) > 1 && (
          <OverviewStrip
            history={overviewShown}
            bounds={bounds}
            view={view}
            color={pill.color}
            tempOnly={thermometer}
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
              <span className="swatch" style={{ background: lineColors[s.key] }} /> {t(s.label)}
            </button>
          ))}
        </div>
        <span className="chip-option">
          <span className="chips-divider" aria-hidden="true" />
          {exclusionsHere.length > 0 && <ExclusionsToggle on={showExclusions} onChange={setShowExclusions} />}
          <SmoothingStepper step={smoothing} onChange={setSmoothing} />
        </span>
      </div>
    </CollapsiblePanel>
  );
}
