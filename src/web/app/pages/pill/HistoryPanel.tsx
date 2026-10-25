import { useCallback, useMemo, useRef, useState } from 'react';
import type { Pill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useHistoryRange, useZoomableHistory } from '../../hooks';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { dateTime } from '../../format';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n';
import { Chart, SERIES, type ChartHandle, type SeriesKey } from '../../components/Chart';
import { OverviewStrip } from '../../components/OverviewStrip';
import { RangePicker } from '../../components/RangePicker';
import { brewAnnotations } from '../../components/annotations';
import { clampWindow, isZoomed, pngFileName, type TimeWindow } from '../../components/chartMath';
import './pill.css';

const SERIES_KEY = 'rapthooker.series';
const loadSeries = (): SeriesKey[] => {
  try {
    const s = JSON.parse(localStorage.getItem(SERIES_KEY) ?? 'null') as SeriesKey[] | null;
    return Array.isArray(s) && s.length ? s.filter((k) => SERIES.some((x) => x.key === k)) : ['gravity', 'temperature'];
  } catch {
    return ['gravity', 'temperature'];
  }
};

export function HistoryPanel({ pill }: { pill: Pill }) {
  const { isOwner, toast, upsertPill } = useLive();
  const u = useUnits();
  const brew = pill.brew;
  const firstAt = Math.min(pill.live.firstReadingAt ?? pill.createdAt, pill.createdAt);
  const { preset, setPreset, custom, setCustom, range } = useHistoryRange({
    initial: brew ? 'brew' : '24h',
    firstAt,
    brewStart: brew?.startedAt ?? null,
  });
  const [view, setView] = useState<TimeWindow | null>(null);
  const [series, setSeries] = useState<SeriesKey[]>(loadSeries);
  const [exporting, setExporting] = useState(false);
  const chart = useRef<ChartHandle>(null);

  const gapMs = Math.max(10 * 60_000, (pill.live.intervalSec ?? 300) * 4000);
  const m = pill.model;
  const reloadKey = [
    pill.offsets.gravity,
    pill.offsets.temperature,
    m.gravitySource,
    (m.tiltPoly ?? []).join(','),
    m.velocitySource,
    m.velocityHours,
    m.smoothing,
  ].join('|');
  const { overview, history, bounds, loading, error } = useZoomableHistory(pill.id, range, view, { points: 1500, gapMs, reloadKey });
  const win = view ? clampWindow(view, bounds) : bounds;
  const zoomed = view !== null && isZoomed(win, bounds);

  const annotations = useMemo(() => brewAnnotations(brew), [brew]);
  const anyImplausible = useMemo(() => history?.implausible?.some((v) => v === true) ?? false, [history]);
  const canPick = isOwner && brew !== null && brew.endedAt === null;

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
    localStorage.setItem(SERIES_KEY, JSON.stringify(ordered));
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

  const setOgFrom = async (ts: number, gravity: number) => {
    if (!brew) return;
    const og = Math.round(gravity * 10000) / 10000;
    try {
      const updated = await api.updateBrew(brew.id, { og });
      upsertPill({ ...pill, brew: updated });
      toast({
        tone: 'success',
        title: t('OG set to {gravity}', { gravity: u.gravityText(og) }),
        body: t('From the reading at {date}', { date: dateTime(ts) }),
      });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't set the OG"), body: errorText(err) });
    }
  };

  return (
    <section className="panel pill-history" aria-label={t('History')}>
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="activity" /> {t('History')}
          </h2>
          <p>{t('Drag across the chart or pinch to zoom; double-tap to see it all. Gaps are times nothing was recorded.')}</p>
        </div>
        <div className="row">
          <button type="button" className="btn small" onClick={() => void exportPng()} disabled={exporting || !history?.ts.length}>
            <Icon name="download" size={16} /> PNG
          </button>
          <a className="btn small" href={api.pillCsvUrl(pill.id)} download>
            <Icon name="download" size={16} /> CSV
          </a>
        </div>
      </div>
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
        <div className="history-lines">
          {zoomed && (
            <button type="button" className="chip on" onClick={resetZoom}>
              <Icon name="x" size={12} /> {t('Show it all')}
            </button>
          )}
          <div className="chips" role="group" aria-label={t('Lines on the chart')}>
            {SERIES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`chip${series.includes(s.key) ? ' on' : ''}`}
                aria-pressed={series.includes(s.key)}
                onClick={() => toggle(s.key)}
              >
                <span className="swatch" style={{ background: s.key === 'gravity' ? pill.color : `var(${s.color})` }} /> {t(s.label)}
              </button>
            ))}
          </div>
        </div>
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
          onPickPoint={canPick ? (ts, g) => void setOgFrom(ts, g) : undefined}
          pickLabel={t('Use as OG')}
          label={t('History of {name}', { name: pill.name })}
        />
        {(overview?.ts.length ?? 0) > 1 && (
          <OverviewStrip history={overview} bounds={bounds} view={view} color={pill.color} onChange={(w) => onZoom(w.from, w.to)} />
        )}
      </div>
      {(anyImplausible || history?.pillGravity || history?.pillVelocity || canPick) && (
        <ul className="chart-notes">
          {anyImplausible && (
            <li>
              <span className="chart-key faded" aria-hidden="true" />{' '}
              {t(
                "Grey dots: readings where the pill didn't look like it was floating. They're left out of the line, brew stats and gravity alerts.",
              )}
            </li>
          )}
          {(history?.pillGravity || history?.pillVelocity) && (
            <li>
              <span className="chart-key dotted" aria-hidden="true" />{' '}
              {t("Dotted lines: the pill's own values, to compare with RaptHooker's. Tap them in the legend to hide them.")}
            </li>
          )}
          {canPick && (
            <li>
              <span className="chart-key og" aria-hidden="true" />{' '}
              {t("Tap or click a reading (or focus the chart and press Enter) to use it as the brew's OG.")}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
