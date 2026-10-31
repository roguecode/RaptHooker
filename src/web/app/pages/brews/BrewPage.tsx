import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Brew } from '@rapthooker/shared';
import { ApiError, api, errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { useUnits } from '../../units';
import { historyGapMs, useZoomableHistory, type HistoryRange } from '../../hooks';
import { href, navigate } from '../../router';
import { dateTime, days, fixed, num, useNow } from '../../format';
import { Icon } from '../../components/Icon';
import { Chart, type SeriesKey } from '../../components/Chart';
import { clampWindow, isZoomed, SMOOTHING_STEPS_MS, type TimeWindow } from '../../components/chartMath';
import { brewAnnotations } from '../../components/annotations';
import { contextWindow, windowsIn } from '../../components/exclusions';
import { ExcludeRangeButton, ExclusionsToggle, useRemoveExclusion, useShowExclusions } from '../../components/ExclusionControls';
import { SmoothingStepper, useChartSmoothing } from '../../components/ChartSmoothing';
import { useScaleRanges } from '../../components/chartScales';
import { FermentBar } from '../../components/Ferment';
import { Confirm } from '../../components/ui';
import { t } from '../../i18n';
import { EditBrewModal } from './EditBrewModal';
import { EventsSection } from './events';
import { abvOf, PredictionStats, StageChip, useAbvFormula } from './Prediction';
import './brews.css';

/** Until the brew has loaded. */
const NO_RANGE: HistoryRange = { from: 0, to: 0, live: false };

export function BrewPage({ id }: { id: string }) {
  const { pills, isOwner, toast } = useLive();
  const u = useUnits();
  const now = useNow(60_000);
  const formula = useAbvFormula();
  const [brew, setBrew] = useState<Brew | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'end' | 'delete' | null>(null);
  const [series, setSeries] = useState<SeriesKey[]>(['gravity', 'temperature']);
  const [zoom, setZoom] = useState<TimeWindow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.brew(id).then(
      (b) => {
        setBrew(b);
        setLoadError(null);
      },
      // Only "not found" means it's gone; otherwise keep what's shown and try again when the hub is back.
      (err: unknown) => (err instanceof ApiError && err.status === 404 ? setBrew(null) : setLoadError(errorText(err))),
    );
  }, [id]);
  useEffect(reload, [reload]);
  useLiveMessages((msg) => {
    if (msg.type === 'hello' && loadError !== null) reload();
    if (msg.type === 'brew' && msg.brew.id === id) setBrew(msg.brew);
    if (msg.type === 'brew-removed' && msg.brewId === id) setBrew(null);
  });

  const pill = brew ? pills.find((p) => p.id === brew.pillId) : undefined;
  const range = useMemo<HistoryRange>(
    () => (brew ? { from: brew.startedAt, to: brew.endedAt ?? Date.now(), live: brew.endedAt === null } : NO_RANGE),
    [brew?.startedAt, brew?.endedAt], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The whole brew, zoomed on the client (with the zoomed-in part fetched in more detail), like a pill's chart.
  const [showExclusions, setShowExclusions] = useShowExclusions();
  const leaveOut = showExclusions && (pill?.exclusions?.length ?? 0) > 0;
  const { history, bounds } = useZoomableHistory(brew?.pillId ?? null, range, zoom, {
    points: 900,
    gapMs: historyGapMs(pill?.live.intervalSec),
    reloadKey: leaveOut ? (pill?.exclusions ?? []).map((e) => `${e.from}-${e.to}`).join(',') : '',
    exclude: leaveOut,
  });
  const win = zoom ? clampWindow(zoom, bounds) : bounds;
  const zoomed = zoom !== null && isZoomed(win, bounds);
  const onZoom = useCallback(
    (from: number, to: number) => {
      const next = { from, to };
      setZoom(isZoomed(next, bounds) ? next : null);
    },
    [bounds],
  );
  const resetZoom = useCallback(() => setZoom(null), []);
  const annotations = useMemo(() => brewAnnotations(brew), [brew]);
  const removeExclusion = useRemoveExclusion(pill);
  const exclusionsHere = brew ? windowsIn(pill?.exclusions, bounds) : [];
  const [smoothing, setSmoothing] = useChartSmoothing();
  const [scaleRanges, setScaleRanges] = useScaleRanges(`brew.${id}`);

  if (brew === undefined)
    return loadError ? <LoadFailed error={loadError} onRetry={reload} /> : <div className="skeleton" style={{ height: '20rem' }} />;
  if (brew === null) {
    return (
      <div className="panel empty">
        <h2>{t('Brew not found')}</h2>
        <a className="btn" href="#/brews">
          {t('All brews')}
        </a>
      </div>
    );
  }
  const running = brew.endedAt === null;
  const s = brew.stats;
  const abv = abvOf(brew);
  const seriesLabel = { gravity: t('Gravity'), temperature: t('Temperature'), velocity: t('Velocity') };

  return (
    <div className="page">
      <div>
        <a className="back" href="#/brews">
          <Icon name="left" size={16} /> {t('All brews')}
        </a>
        <div className="panel hero brew-hero" style={{ '--pill': pill?.color ?? 'var(--violet-2)' } as React.CSSProperties}>
          <div style={{ minWidth: 0 }}>
            <div className="row">
              <h1>{brew.name}</h1>
              <StageChip brew={brew} />
            </div>
            <div className="meta">
              {brew.style && <span>{brew.style}</span>}
              <span>
                {/* i18n: a brew that is still running lasts from its start until "now" */}
                {dateTime(brew.startedAt)} → {running ? t('now') : dateTime(brew.endedAt)} ({days((brew.endedAt ?? now) - brew.startedAt)})
              </span>
              {pill ? <a href={href.pill(pill.id)}>{t('on {pill}', { pill: pill.name })}</a> : <span>{t('pill removed')}</span>}
            </div>
          </div>
          <div className="row">
            <a className="btn small" href={href.brewSummary(brew.id)}>
              <Icon name="file" size={16} /> {t('Summary')}
            </a>
            <a className="btn small" href={api.brewCsvUrl(brew.id)} download>
              <Icon name="download" size={16} /> CSV
            </a>
            {isOwner && (
              <>
                <button type="button" className="btn small" onClick={() => setEditing(true)}>
                  <Icon name="pencil" size={14} /> {t('Edit')}
                </button>
                {running ? (
                  <button type="button" className="btn small danger" onClick={() => setConfirm('end')}>
                    <Icon name="stop" size={14} /> {t('End brew')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() =>
                      api
                        .updateBrew(brew.id, { endedAt: null })
                        .then(setBrew, (err) => toast({ tone: 'error', title: t("Couldn't resume"), body: errorText(err) }))
                    }
                  >
                    <Icon name="undo" size={14} /> {t('Resume')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <FermentBar brew={brew} />

      <div className="stat-row">
        <div
          className="stat"
          title={s.ogAuto ? t('From the pill: the middle reading from its first to third hour in the wort') : undefined}
        >
          <div className="k">{t('Original gravity')}</div>
          <div className="v">
            {u.gravityText(s.og)}
            {s.ogAuto && s.og !== null && <small>{t('auto')}</small>}
          </div>
        </div>
        <div className="stat">
          <div className="k">{running ? t('Current gravity') : t('Final gravity')}</div>
          <div className="v">{u.gravityText(s.gravity)}</div>
        </div>
        <div className="stat">
          <div className="k">{t('Target FG')}</div>
          <div className="v">{u.gravityText(brew.targetFg)}</div>
        </div>
        <div className="stat" title={`${t(formula.label)}: ${formula.formula}`}>
          <div className="k">{abv.final ? (running ? t('Final ABV') : t('ABV')) : t('ABV so far')}</div>
          <div className="v">
            {abv.value === null ? '–' : fixed(abv.value, 2)}
            <small>%</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">{t('Attenuation')}</div>
          <div className="v">
            {s.attenuation === null ? '–' : fixed(s.attenuation, 1)}
            <small>%</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">{t('Temperature')}</div>
          <div className="v">
            {s.tempAvg === null ? '–' : fixed(u.tempValue(s.tempAvg), 1)}
            <small>{t('{unit} avg', { unit: u.tempLabel })}</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">{t('Range')}</div>
          <div className="v">{s.tempMin === null ? '–' : `${fixed(u.tempValue(s.tempMin), 1)}–${fixed(u.tempValue(s.tempMax!), 1)}`}</div>
        </div>
        <div className="stat">
          <div className="k">{t('Readings')}</div>
          <div className="v">{num(s.readings)}</div>
        </div>
        <PredictionStats brew={brew} now={now} />
      </div>

      <section className="panel">
        <div className="chart-toolbar">
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{t('Fermentation')}</h2>
        </div>
        <Chart
          history={history}
          series={series}
          from={win.from}
          to={win.to}
          bounds={bounds}
          gravityColor={pill?.color}
          targetFg={brew.targetFg}
          annotations={annotations}
          onZoom={onZoom}
          onResetZoom={resetZoom}
          smoothMs={SMOOTHING_STEPS_MS[smoothing]}
          exclusions={showExclusions && exclusionsHere.length > 0 ? exclusionsHere : undefined}
          onRemoveExclusion={isOwner ? removeExclusion : undefined}
          scaleRanges={scaleRanges}
          onScaleRangesChange={setScaleRanges}
        />
        <div className="chart-controls">
          {zoomed && (
            <button type="button" className="chip on" onClick={resetZoom}>
              <Icon name="x" size={12} /> {t('Reset zoom')}
            </button>
          )}
          {zoomed && isOwner && pill && (
            <ExcludeRangeButton
              pill={pill}
              range={win}
              onExcluded={(r) => {
                setShowExclusions(true);
                setZoom(contextWindow(r, bounds));
              }}
            />
          )}
          <div className="chips" role="group" aria-label={t('Lines on the chart')}>
            {(['gravity', 'temperature', 'velocity'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`chip${series.includes(k) ? ' on' : ''}`}
                aria-pressed={series.includes(k)}
                onClick={() => setSeries((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]))}
              >
                {seriesLabel[k]}
              </button>
            ))}
          </div>
          <span className="chip-option">
            <span className="chips-divider" aria-hidden="true" />
            {exclusionsHere.length > 0 && <ExclusionsToggle on={showExclusions} onChange={setShowExclusions} />}
            <SmoothingStepper step={smoothing} onChange={setSmoothing} />
          </span>
        </div>
      </section>

      <section className="panel">
        <EventsSection brew={brew} onChanged={reload} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>
            <Icon name="pencil" /> {t('Notes')}
          </h2>
        </div>
        {brew.notes ? (
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{brew.notes}</p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('No notes yet.')}
          </p>
        )}
      </section>

      {isOwner && (
        <div>
          <button type="button" className="btn danger small" onClick={() => setConfirm('delete')}>
            <Icon name="trash" size={14} /> {t('Delete brew')}
          </button>
          <p className="hint">{t("Deleting a brew keeps the pill's readings; only the brew record (and its events) goes.")}</p>
        </div>
      )}

      {editing && <EditBrewModal brew={brew} onClose={() => setEditing(false)} onSaved={setBrew} />}
      {confirm === 'end' && (
        <Confirm
          title={t('End "{name}"?', { name: brew.name })}
          body={<p>{t('Its final stats are saved. The pill keeps recording.')}</p>}
          confirm={t('End brew')}
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            api.endBrew(brew.id).then(setBrew, (err) => toast({ tone: 'error', title: t("Couldn't end the brew"), body: errorText(err) }))
          }
        />
      )}
      {confirm === 'delete' && (
        <Confirm
          title={t('Delete "{name}"?', { name: brew.name })}
          body={<p>{t("The brew record and its events go; the pill's readings stay.")}</p>}
          confirm={t('Delete')}
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await api.deleteBrew(brew.id);
              navigate('#/brews');
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't delete"), body: errorText(err) });
            }
          }}
        />
      )}
    </div>
  );
}

/** A brew that couldn't be loaded (the hub didn't answer, say), with a way to try again. */
export function LoadFailed({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="panel empty">
      <h2>{error}</h2>
      <button type="button" className="btn" onClick={onRetry}>
        {t('Try again')}
      </button>
    </div>
  );
}
