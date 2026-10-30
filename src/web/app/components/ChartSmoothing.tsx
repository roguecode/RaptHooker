import { useCallback, useState } from 'react';
import { num } from '../format';
import { t } from '../i18n';
import { Icon } from './Icon';
import { SMOOTHING_STEPS_MS } from './chartMath';

const KEY = 'rapthooker.smoothing';
const MAX = SMOOTHING_STEPS_MS.length - 1;

/** How much the charts' lines are smoothed (0: the readings as they are), remembered in this browser. */
export function useChartSmoothing(): [number, (step: number) => void] {
  const [step, setStep] = useState(() => {
    try {
      const n = Number(localStorage.getItem(KEY) ?? 0);
      return Number.isInteger(n) && n >= 0 && n <= MAX ? n : 0;
    } catch {
      return 0;
    }
  });
  const set = useCallback((next: number) => {
    const s = Math.max(0, Math.min(MAX, next));
    setStep(s);
    try {
      localStorage.setItem(KEY, String(s));
    } catch {}
  }, []);
  return [step, set];
}

const windowText = (ms: number) => (ms < 3_600_000 ? t('{n} min', { n: num(ms / 60_000) }) : t('{n} h', { n: num(ms / 3_600_000) }));

/** − Smoothing n +: smooths the chart's lines for the eye; the readings themselves don't change. */
export function SmoothingStepper({ step, onChange }: { step: number; onChange: (step: number) => void }) {
  const ms = SMOOTHING_STEPS_MS[step] ?? 0;
  const about =
    ms > 0
      ? t('Lines averaged over {time}. Only the chart changes: the readings stay as they are.', { time: windowText(ms) })
      : t('The readings as they are');
  return (
    <div className={`stepper${step > 0 ? ' on' : ''}`} role="group" aria-label={t('Smoothing')} title={about}>
      <span className="stepper-label">{t('Smoothing')}</span>
      <button type="button" className="icon-btn" aria-label={t('Less smoothing')} disabled={step === 0} onClick={() => onChange(step - 1)}>
        <Icon name="minus" size={14} />
      </button>
      <span className="stepper-value" aria-live="polite" aria-atomic="true">
        {step}
        <span className="chart-sr"> {about}</span>
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('More smoothing')}
        disabled={step === MAX}
        onClick={() => onChange(step + 1)}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
