import { useState, type FormEvent } from 'react';
import { toLocalInput } from '../format';
import { Icon } from './Icon';
import { checkCustomRange, RANGE_PRESETS, type RangePreset, type TimeWindow } from './chartMath';
import { t } from '../i18n';
import './Chart.css';

/** Preset ranges (6 hours to everything, or the running brew) and a custom from–to. */
export function RangePicker({
  preset,
  custom,
  hasBrew,
  onPreset,
  onCustom,
}: {
  preset: RangePreset;
  custom: TimeWindow | null;
  hasBrew: boolean;
  onPreset: (preset: Exclude<RangePreset, 'custom'>) => void;
  onCustom: (win: TimeWindow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    if (!open) {
      const now = Date.now();
      setFromText(toLocalInput(custom?.from ?? now - 7 * 86_400_000));
      setToText(toLocalInput(Math.min(custom?.to ?? now, now)));
      setError(null);
    }
    setOpen(!open);
  };
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const checked = checkCustomRange(fromText, toText, Date.now());
    if (typeof checked === 'string') return setError(checked);
    setError(null);
    setOpen(false);
    onCustom(checked);
  };

  return (
    <div className="range-picker">
      <div className="segmented range-presets" role="group" aria-label={t('Time range')}>
        {RANGE_PRESETS.filter((p) => p.id !== 'brew' || hasBrew).map((p) => (
          <button
            key={p.id}
            type="button"
            className={preset === p.id ? 'on' : ''}
            aria-pressed={preset === p.id}
            title={t(p.title)}
            aria-label={t(p.title)}
            onClick={() => {
              setOpen(false);
              onPreset(p.id);
            }}
          >
            {t(p.label)}
          </button>
        ))}
        <button
          type="button"
          className={preset === 'custom' ? 'on' : ''}
          aria-pressed={preset === 'custom'}
          aria-expanded={open}
          title={t('Pick the start and end')}
          onClick={toggle}
        >
          <Icon name="calendar" size={13} /> {t('Custom')}
        </button>
      </div>
      {open && (
        <form className="range-custom" onSubmit={apply} aria-label={t('Custom range')}>
          <label className="field">
            <span>{t('From')}</span>
            <input className="input" type="datetime-local" value={fromText} onChange={(e) => setFromText(e.target.value)} required />
          </label>
          <label className="field">
            <span>{t('To')}</span>
            <input className="input" type="datetime-local" value={toText} onChange={(e) => setToText(e.target.value)} required />
          </label>
          <div className="row range-custom-actions">
            <button type="submit" className="btn small primary">
              {t('Show')}
            </button>
            <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </button>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
