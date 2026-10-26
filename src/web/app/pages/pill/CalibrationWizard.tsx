import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { fitTilt, SG_LIMITS, type Pill, type PillPatchBody, type TiltPoint } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { useUnits } from '../../units';
import { useTheme } from '../../theme';
import { dateTime, duration, fixed, num, timeAgo, useNow } from '../../format';
import { Modal } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { t, tk, tp } from '../../i18n';
import {
  baseGravity,
  fitCurve,
  MAX_TILT_POINTS,
  OFFSET_LIMITS,
  points,
  readingState,
  residualText,
  thermometerOffset,
  tiltAdvice,
  tiltFit,
  waterOffset,
} from './calibration';
import './pill.css';

export type CalibrationStep = 'water' | 'thermometer' | 'tilt';

const STEPS: { id: CalibrationStep; label: string }[] = [
  { id: 'water', label: tk('Water check') },
  { id: 'thermometer', label: tk('Thermometer') },
  { id: 'tilt', label: tk('Tilt points') },
];

type Save = (patch: PillPatchBody, message: string) => Promise<boolean>;

/** Step-by-step calibration for the owner: gravity offset, temperature offset and tilt calibration points. */
export function CalibrationWizard({
  pillId,
  step: initial = 'water',
  onClose,
}: {
  pillId: string;
  step?: CalibrationStep;
  onClose: () => void;
}) {
  const { pills, upsertPill, toast } = useLive();
  const pill = pills.find((p) => p.id === pillId);
  const [step, setStep] = useState<CalibrationStep>(initial);
  const [fresh, setFresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useLiveMessages((msg) => {
    if (msg.type === 'reading' && msg.pillId === pillId) setFresh((n) => n + 1);
  });

  if (!pill) {
    return (
      <Modal title={t('Calibrate')} onClose={onClose}>
        <p className="muted">{t('This pill has been removed.')}</p>
      </Modal>
    );
  }

  const save: Save = async (patch, message) => {
    setBusy(true);
    setError(null);
    try {
      upsertPill(await api.updatePill(pill.id, patch));
      toast({ tone: 'success', title: message });
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Calibrate {name}', { name: pill.name })} onClose={onClose} wide>
      <p className="muted calib-intro">
        {t(
          'Each step stands on its own: do the ones you need. Values update as the pill sends readings, so keep this open while it floats.',
        )}
      </p>
      <div className="segmented calib-tabs" role="tablist" aria-label={t('Calibration steps')}>
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`calib-tab-${s.id}`}
            aria-selected={step === s.id}
            aria-controls="calib-panel"
            className={step === s.id ? 'on' : ''}
            onClick={() => {
              setStep(s.id);
              setError(null);
            }}
          >
            {i + 1}. {t(s.label)}
          </button>
        ))}
      </div>
      <div id="calib-panel" role="tabpanel" aria-labelledby={`calib-tab-${step}`} className="calib-panel">
        <LatestReading pill={pill} fresh={fresh} needsFloating={step !== 'thermometer'} />
        {step === 'water' && <WaterStep pill={pill} save={save} busy={busy} />}
        {step === 'thermometer' && <ThermometerStep pill={pill} save={save} busy={busy} />}
        {step === 'tilt' && <TiltStep pill={pill} save={save} busy={busy} />}
        {error && (
          <div className="notice danger" role="alert">
            <Icon name="alert" />
            <p>{error}</p>
          </div>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t('Done')}
        </button>
      </div>
    </Modal>
  );
}

function LatestReading({ pill, fresh, needsFloating }: { pill: Pill; fresh: number; needsFloating: boolean }) {
  const u = useUnits();
  const now = useNow(5000);
  const r = pill.live.latest;
  const state = readingState(r, pill.live.intervalSec, now);
  return (
    <div className="calib-live" aria-live="polite">
      <div className="calib-live-head">
        <span className={`status-dot${state === 'fresh' ? ' on' : ''}`} />
        <strong>{t('Latest reading')}</strong>
        <span className="muted">{r ? timeAgo(r.ts, now) : t('none yet')}</span>
        {fresh > 0 && <span className="chip">{tp(fresh, '{count} new since you opened this', '{count} new since you opened this')}</span>}
      </div>
      {r && (
        <div className="calib-live-values num">
          <span>{u.gravityText(r.gravity)}</span>
          <span>{u.tempText(r.temperature, 2)}</span>
          <span>{t('tilt {value}', { value: r.tilt === null ? '–' : `${fixed(r.tilt, 1)}°` })}</span>
        </div>
      )}
      {state === 'none' && <p className="hint">{t('Waiting for the pill to send a reading.')}</p>}
      {state === 'stale' && (
        <p className="calib-warn">
          <Icon name="alert" size={14} />{' '}
          {pill.live.intervalSec
            ? t('This reading is old (expected one every {interval}). Is the pill awake and in range?', {
                interval: duration(pill.live.intervalSec * 1000),
              })
            : t('This reading is old (expected one every few minutes). Is the pill awake and in range?')}
        </p>
      )}
      {r && !r.plausible && needsFloating && (
        <p className="calib-warn">
          <Icon name="alert" size={14} /> {t("This reading doesn't look like the pill is floating. Check it's upright in the liquid.")}
        </p>
      )}
    </div>
  );
}

function WaterStep({ pill, save, busy }: { pill: Pill; save: Save; busy: boolean }) {
  const u = useUnits();
  const r = pill.live.latest;
  const interval = pill.live.intervalSec;
  const base = r ? baseGravity(r, pill.offsets, pill.model) : null;
  const next = base === null ? null : waterOffset(base);
  const tooBig = next !== null && Math.abs(next) > OFFSET_LIMITS.gravity;
  const far = base !== null && Math.abs(1 - base) > 0.01;
  const same = next !== null && Math.abs(next - pill.offsets.gravity) < 0.00005;
  return (
    <div className="stack calib-step">
      <ol className="steps">
        <li>{t('Fill a jug with plain tap water at about 20 °C (68 °F).')}</li>
        <li>
          {interval
            ? t('Float the pill in it, knock off any bubbles and wait for 2–3 readings (about {time}).', {
                time: duration(interval * 3000),
              })
            : t('Float the pill in it, knock off any bubbles and wait for 2–3 readings.')}
        </li>
        <li>{t("Plain water should read {gravity}. If it doesn't, set the offset here.", { gravity: u.gravityText(1) })}</li>
      </ol>
      <dl className="kv">
        <dt>{t('Reading now')}</dt>
        <dd className="num">{base === null ? '–' : u.gravityText(base + pill.offsets.gravity)}</dd>
        <dt>{t('Offset now')}</dt>
        <dd>{points(pill.offsets.gravity)}</dd>
        <dt>{t('New offset')}</dt>
        <dd>
          <strong>{next === null ? '–' : points(next)}</strong>
        </dd>
        <dt>{t('Water will read')}</dt>
        <dd className="num">{next === null || base === null ? '–' : u.gravityText(base + next)}</dd>
      </dl>
      {pill.model.gravitySource === 'tilt' && (
        <p className="hint">
          {t('Gravity is worked out from the tilt, so the offset is added to that. Usually the tilt points are enough on their own.')}
        </p>
      )}
      {far && !tooBig && (
        <p className="calib-warn">
          <Icon name="alert" size={14} /> {t("That's more than 10 points out. Make sure it's plain water and the pill is floating freely.")}
        </p>
      )}
      {tooBig && (
        <p className="calib-warn">
          <Icon name="alert" size={14} /> {t("That's more than an offset can fix (50 points). Is the pill floating in plain water?")}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={busy || next === null || tooBig || same || !r?.plausible}
          onClick={() =>
            next !== null &&
            void save(
              { offsets: { gravity: next, temperature: pill.offsets.temperature } },
              t('Gravity offset set to {offset}', { offset: points(next) }),
            )
          }
        >
          <Icon name="check" size={16} />{' '}
          {same ? t('Already set') : next === null ? t('Set the offset') : t('Set the offset to {offset}', { offset: points(next) })}
        </button>
        {pill.offsets.gravity !== 0 && (
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => void save({ offsets: { gravity: 0, temperature: pill.offsets.temperature } }, t('Gravity offset cleared'))}
          >
            {t('Clear the offset')}
          </button>
        )}
      </div>
    </div>
  );
}

function ThermometerStep({ pill, save, busy }: { pill: Pill; save: Save; busy: boolean }) {
  const u = useUnits();
  const r = pill.live.latest;
  const [text, setText] = useState('');
  const ref = text.trim() === '' ? null : Number(text);
  const refC = ref === null || !Number.isFinite(ref) ? null : u.tempFromDisplay(ref);
  const next = refC === null || !r ? null : thermometerOffset(refC, r, pill.offsets);
  const tooBig = next !== null && Math.abs(next) > OFFSET_LIMITS.temperature;
  const delta = (c: number) => `${u.tempDelta(c) > 0 ? '+' : ''}${fixed(u.tempDelta(c), 2)} ${u.tempLabel}`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next === null || tooBig) return;
    void save(
      { offsets: { gravity: pill.offsets.gravity, temperature: next } },
      t('Temperature offset set to {offset}', { offset: delta(next) }),
    );
  };
  return (
    <form className="stack calib-step" onSubmit={submit}>
      <ol className="steps">
        <li>{t('Put the pill and a thermometer you trust in the same liquid (a jug of water, or the fermenter).')}</li>
        <li>{t('Give them a few minutes to settle, wait for a new reading, then type what the thermometer says.')}</li>
      </ol>
      <div className="form-grid">
        <label className="field">
          <span>{t('Your thermometer reads ({unit})', { unit: u.tempLabel })}</span>
          <input
            className="input num"
            type="number"
            inputMode="decimal"
            step="0.1"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={r ? u.tempValue(r.temperature).toFixed(1) : undefined}
          />
        </label>
      </div>
      <dl className="kv">
        <dt>{t('Pill reads now')}</dt>
        <dd className="num">{r ? u.tempText(r.temperature, 2) : '–'}</dd>
        <dt>{t('Offset now')}</dt>
        <dd>{delta(pill.offsets.temperature)}</dd>
        <dt>{t('New offset')}</dt>
        <dd>
          <strong>{next === null ? '–' : delta(next)}</strong>
        </dd>
      </dl>
      {tooBig && (
        <p className="calib-warn">
          <Icon name="alert" size={14} /> {t("That's more than 10 °C out: check the number and that both are in the same liquid.")}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy || next === null || tooBig}>
          <Icon name="check" size={16} /> {t('Set the offset')}
        </button>
        {pill.offsets.temperature !== 0 && (
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => void save({ offsets: { gravity: pill.offsets.gravity, temperature: 0 } }, t('Temperature offset cleared'))}
          >
            {t('Clear the offset')}
          </button>
        )}
      </div>
    </form>
  );
}

function TiltStep({ pill, save, busy }: { pill: Pill; save: Save; busy: boolean }) {
  const u = useUnits();
  const r = pill.live.latest;
  const m = pill.model;
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const pts = m.tiltPoints;
  const ptsKey = JSON.stringify(pts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fit = useMemo(() => tiltFit(pts), [ptsKey]);
  const usingTilt = m.gravitySource === 'tilt';
  const full = pts.length >= MAX_TILT_POINTS;
  const already = r !== null && pts.some((p) => p.at === r.ts);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!r || r.tilt === null) return setProblem(t('Wait for a reading with a tilt first.'));
    const v = Number(text);
    if (text.trim() === '' || !Number.isFinite(v)) return setProblem(t('Type the gravity you measured.'));
    const sg = Math.round(u.gravityFromDisplay(v) * 10000) / 10000;
    if (sg < SG_LIMITS.min || sg > SG_LIMITS.max) {
      return setProblem(t("That's outside {min} to {max}.", { min: u.gravityText(SG_LIMITS.min), max: u.gravityText(SG_LIMITS.max) }));
    }
    const point: TiltPoint = { tilt: Math.round(r.tilt * 100) / 100, sg, at: r.ts };
    if (
      await save(
        { model: { tiltPoints: [...pts, point].slice(-MAX_TILT_POINTS) } },
        t('Point added: {tilt}° = {gravity}', { tilt: fixed(point.tilt, 1), gravity: u.gravityText(sg) }),
      )
    ) {
      setText('');
    }
  };
  const remove = (i: number) => {
    const next = pts.filter((_p, j) => j !== i);
    const stillFits = fitTilt(next) !== null;
    void save(
      { model: { tiltPoints: next, ...(usingTilt && !stillFits ? { gravitySource: 'pill' as const } : {}) } },
      usingTilt && !stillFits ? t("Point deleted. Too few left, so it's back to the pill's gravity") : t('Point deleted'),
    );
  };

  return (
    <div className="stack calib-step">
      <ol className="steps">
        <li>
          {t(
            'Make up a liquid of known gravity (sugar or malt extract in water works) and measure it with a hydrometer or refractometer. Plain water is {gravity}.',
            { gravity: u.gravityText(1) },
          )}
        </li>
        <li>{t('Float the pill in it at about 20 °C (68 °F) and wait for a reading or two.')}</li>
        <li>{t('Type the gravity you measured and press Add point.')}</li>
      </ol>
      <p className="hint" style={{ marginTop: 0 }}>
        {t(
          'Aim for 3–6 points spread from water to the highest OG you brew. RaptHooker draws a straight line through 2 points and a curve through 3 or more, then works the gravity out from how the pill tilts.',
        )}
      </p>
      <form className="calib-add" onSubmit={(e) => void add(e)}>
        <div className="calib-tilt-now">
          <span className="reading-label">{t('Tilt now')}</span>
          <strong className="num">{r?.tilt != null ? `${fixed(r.tilt, 1)}°` : '–'}</strong>
        </div>
        <label className="field">
          <span>{t('Known gravity ({unit})', { unit: u.gravityLabel })}</span>
          <input
            className="input num"
            type="number"
            inputMode="decimal"
            step={u.gravity === 'plato' ? '0.1' : '0.001'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={u.gravity === 'plato' ? '12.0' : '1.050'}
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy || full || !r || r.tilt === null || already}>
          <Icon name="plus" size={16} /> {t('Add point')}
        </button>
      </form>
      {problem && <p className="field-error">{problem}</p>}
      {full && <p className="hint">{t("That's the most ({max}). Delete one to add another.", { max: MAX_TILT_POINTS })}</p>}
      {already && !full && (
        <p className="hint">{t("You've added a point from this reading. Wait for the next one (or delete it below).")}</p>
      )}

      {pts.length > 0 && (
        <div className="calib-points">
          <table className="calib-table">
            <thead>
              <tr>
                <th scope="col">{t('Tilt')}</th>
                <th scope="col">{t('Gravity')}</th>
                {/* i18n: the gravity the fitted curve gives for a calibration point */}
                <th scope="col">{t('Fit')}</th>
                <th scope="col">{t('Off by')}</th>
                <th scope="col" className="hide-mobile">
                  {t('Added')}
                </th>
                <th scope="col">
                  <span className="pill-sr">{t('Delete')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {fit.rows.map((row, i) => (
                <tr key={`${row.point.at}-${i}`}>
                  <td className="num">{fixed(row.point.tilt, 1)}°</td>
                  <td className="num">{u.gravityText(row.point.sg)}</td>
                  <td className="num">{row.fitted === null ? '–' : u.gravityText(row.fitted)}</td>
                  <td className={`num${row.residual !== null && Math.abs(row.residual) > 2 ? ' calib-off' : ''}`}>
                    {row.residual === null ? '–' : residualText(row.residual)}
                  </td>
                  <td className="muted hide-mobile">{dateTime(row.point.at)}</td>
                  <td>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={t('Delete the point at {tilt}°', { tilt: fixed(row.point.tilt, 1) })}
                      disabled={busy}
                      onClick={() => remove(i)}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <TiltFitChart pts={pts} coeffs={fit.coeffs} />
          {fit.rms !== null && pts.length > 2 && (
            <p className="hint">
              {fit.rms > 2
                ? t('On average the points are {rms} points from the curve: re-measure any that are far out, or delete them.', {
                    rms: fixed(fit.rms, 1),
                  })
                : t('On average the points are {rms} points from the curve.', { rms: fixed(fit.rms, 1) })}
            </p>
          )}
        </div>
      )}
      <p className="hint">{tiltAdvice(pts)}</p>

      {usingTilt ? (
        <div className="notice">
          <Icon name="check" />
          <div className="grow">
            <p>
              <strong>{t('Gravity is worked out by RaptHooker from the tilt.')}</strong>
            </p>
            {pill.offsets.gravity !== 0 && (
              <p className="hint">{t('Your gravity offset ({offset}) is added on top.', { offset: points(pill.offsets.gravity) })}</p>
            )}
          </div>
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() => void save({ model: { gravitySource: 'pill' } }, t("Using the pill's gravity"))}
          >
            {t("Use the pill's gravity")}
          </button>
        </div>
      ) : (
        fit.coeffs && (
          <div className="notice">
            <Icon name="sparkles" />
            <div className="grow">
              <p>
                <strong>{t('Ready.')}</strong> {t('Switch to gravity worked out from the tilt?')}
                {r?.tilt != null && (
                  <>
                    {' '}
                    {t('Right now that would read {tilt} (the pill says {pill}).', {
                      tilt: u.gravityText(
                        (baseGravity(r, pill.offsets, { gravitySource: 'tilt', tiltPoly: fit.coeffs }) ?? NaN) + pill.offsets.gravity,
                      ),
                      pill: u.gravityText(r.pillGravity),
                    })}
                  </>
                )}
              </p>
              {pill.offsets.gravity !== 0 && (
                <p className="hint">
                  {t('Your gravity offset ({offset}) will still be added on top; you may want to clear it.', {
                    offset: points(pill.offsets.gravity),
                  })}
                </p>
              )}
            </div>
            <button
              type="button"
              className="btn small primary"
              disabled={busy}
              onClick={() => void save({ model: { gravitySource: 'tilt' } }, t('Gravity is now worked out from the tilt'))}
            >
              {t('Use it')}
            </button>
          </div>
        )
      )}
    </div>
  );
}

const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function TiltFitChart({ pts, coeffs }: { pts: TiltPoint[]; coeffs: number[] | null }) {
  const box = useRef<HTMLDivElement | null>(null);
  const u = useUnits();
  const { theme } = useTheme();
  const latest = useRef({ pts, coeffs });
  latest.current = { pts, coeffs };
  // The pill (and so these arrays) is replaced with every reading; only redraw when the points change.
  const key = JSON.stringify([pts, coeffs]);
  useEffect(() => {
    const el = box.current;
    const { pts, coeffs } = latest.current;
    if (!el || pts.length === 0) return;
    const c = fitCurve(pts, coeffs);
    const conv = (v: number | null) => (v === null ? null : u.gravityValue(v));
    const data: AlignedData = [c.x, c.points.map(conv), c.curve.map(conv)];
    const muted = cssVar('--muted', '#a9a3d6');
    const grid = cssVar('--grid', 'rgba(167, 139, 250, 0.08)');
    const color = cssVar('--series-gravity', '#a78bfa');
    const pointColor = cssVar('--series-tilt', '#60a5fa');
    const plato = u.gravity === 'plato';
    const axis = { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px system-ui, sans-serif' };
    const chart = new uPlot(
      {
        width: Math.max(240, el.clientWidth),
        height: 190,
        padding: [10, 12, 0, 0],
        legend: { show: false },
        cursor: { show: false },
        scales: { x: { time: false } },
        axes: [
          { ...axis, values: (_p, vals) => vals.map((v) => `${num(v, 2, 0)}°`) },
          { ...axis, size: 52, values: (_p, vals) => vals.map((v) => (plato ? num(v, 1) : num(v, 3))) },
        ],
        series: [
          {},
          {
            label: t('Points'),
            stroke: pointColor,
            paths: () => null,
            points: { show: true, size: 9, width: 2, stroke: pointColor, fill: pointColor },
          },
          { label: t('Fit'), stroke: color, width: 2, spanGaps: true, points: { show: false } },
        ],
      },
      data,
      el,
    );
    const ro = new ResizeObserver(() => {
      const w = Math.max(240, el.clientWidth);
      if (w !== chart.width) chart.setSize({ width: w, height: 190 });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.destroy();
    };
  }, [key, u, theme]);
  return (
    <div
      ref={box}
      className="tilt-fit"
      role="img"
      aria-label={tp(
        pts.length,
        'Tilt calibration: {count} point and the line fitted through it',
        'Tilt calibration: {count} points and the line fitted through them',
      )}
    />
  );
}
