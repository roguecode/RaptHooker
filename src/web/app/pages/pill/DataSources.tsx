import { useEffect, useId, useState, type ReactNode } from 'react';
import { fitTilt, polyval, type Pill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { fixed } from '../../format';
import { Icon } from '../../components/Icon';
import { t, tc, tp } from '../../i18n';
import { DEFAULT_CHOICES as DEFAULTS, describeChanges, type SourceChoices as Choices } from './calibration';
import './pill.css';

interface Option<T extends string> {
  id: T;
  label: string;
  hint: string;
  disabled?: boolean;
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  children,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  children?: ReactNode;
}) {
  const id = useId();
  const current = options.find((o) => o.id === value);
  return (
    <div className="source-choice">
      <span id={id} className="label">
        {label}
      </span>
      <div className={`segmented source-seg${options.length > 2 ? ' three' : ''}`} role="radiogroup" aria-labelledby={id}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            className={value === o.id ? 'on' : ''}
            disabled={o.disabled}
            title={o.disabled ? o.hint : undefined}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {current && <p className="hint source-hint">{current.hint}</p>}
      {children}
    </div>
  );
}

const velocityText = (v: number | null | undefined) =>
  v === null || v === undefined
    ? t('not known yet')
    : t('{value} /day', { value: `${v > 0 ? '+' : v < 0 ? '−' : ''}${fixed(Math.abs(v), 1)}` });

/** "Where the numbers come from": the pill's own values (the default) or RaptHooker's. */
export function DataSources({ pill, onCalibrateTilt }: { pill: Pill; onCalibrateTilt: () => void }) {
  const { upsertPill, toast } = useLive();
  const u = useUnits();
  const m = pill.model;
  const saved: Choices = {
    gravitySource: m.gravitySource,
    velocitySource: m.velocitySource,
    velocityHours: m.velocityHours,
    smoothing: m.smoothing,
  };
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<Choices>(saved);
  const [hoursText, setHoursText] = useState(String(m.velocityHours));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = JSON.parse(savedKey) as Choices;
    setDraft(s);
    setHoursText(String(s.velocityHours));
  }, [savedKey]);

  const poly = m.tiltPoly ?? fitTilt(m.tiltPoints);
  const canTilt = poly !== null;
  const r = pill.live.latest;
  const tiltNow = poly && r?.tilt != null ? polyval(poly, r.tilt) + pill.offsets.gravity : null;
  const hours = Number(hoursText);
  const hoursOk = Number.isInteger(hours) && hours >= 6 && hours <= 72;
  const next: Choices = { ...draft, velocityHours: hoursOk ? hours : draft.velocityHours };
  const changes = describeChanges(saved, next);
  const isDefault = JSON.stringify(saved) === JSON.stringify({ ...DEFAULTS, velocityHours: saved.velocityHours });

  const save = async (to: Choices, message: string) => {
    const patch: Partial<Choices> = {};
    for (const k of Object.keys(to) as (keyof Choices)[]) if (to[k] !== saved[k]) (patch as Record<string, unknown>)[k] = to[k];
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    setError(null);
    try {
      upsertPill(await api.updatePill(pill.id, { model: patch }));
      toast({ tone: 'success', title: message });
    } catch (err) {
      setError(errorText(err));
      toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="data-sources" aria-labelledby="sources-title">
      <h3 id="sources-title" className="row">
        <Icon name="sliders" size={16} /> {t('Where the numbers come from')}
      </h3>
      <p className="hint source-lead">
        {t("By default every number is the pill's own. You can let RaptHooker work some of them out instead, and switch back any time.")}
      </p>

      <Choice
        label={t('Gravity')}
        value={draft.gravitySource}
        onChange={(gravitySource) => setDraft({ ...draft, gravitySource })}
        options={[
          { id: 'pill', label: t('From the pill (default)'), hint: t('What the pill sends, using its own calibration from the RAPT app.') },
          {
            id: 'tilt',
            label: t('Worked out by RaptHooker from the tilt'),
            hint: canTilt
              ? t("RaptHooker turns the pill's tilt into gravity using your tilt calibration points.")
              : t('Needs a tilt calibration first: at least 2 points.'),
            disabled: !canTilt,
          },
        ]}
      >
        {r && (
          <p className="source-now num">
            {t('Right now: pill {gravity}', { gravity: u.gravityText(r.pillGravity) })}
            {tiltNow !== null && <> · {t('from the tilt {gravity}', { gravity: u.gravityText(tiltNow) })}</>}
          </p>
        )}
        <div>
          <button type="button" className="btn small ghost" onClick={onCalibrateTilt}>
            <Icon name="tilt" size={14} />{' '}
            {canTilt
              ? tp(m.tiltPoints.length, 'Tilt calibration ({count} point)', 'Tilt calibration ({count} points)')
              : t('Set up a tilt calibration')}
          </button>
        </div>
      </Choice>

      <Choice
        label={t('Velocity')}
        value={draft.velocitySource}
        onChange={(velocitySource) => setDraft({ ...draft, velocitySource })}
        options={[
          { id: 'pill', label: t('From the pill (default)'), hint: t('The gravity velocity (points per day) the pill works out itself.') },
          {
            id: 'computed',
            label: t('Worked out by RaptHooker'),
            hint: tp(
              next.velocityHours,
              "A straight line through the last {count} hour of readings, leaving out any where the pill wasn't floating.",
              "A straight line through the last {count} hours of readings, leaving out any where the pill wasn't floating.",
            ),
          },
        ]}
      >
        <p className="source-now num">
          {t('Right now: pill {pill} · RaptHooker {ours}', {
            pill: velocityText(r?.pillVelocity),
            ours: velocityText(pill.live.computedVelocity),
          })}
        </p>
        <label className="field source-hours">
          <span>{t('Hours of readings RaptHooker uses')}</span>
          <input
            className="input num"
            type="number"
            min={6}
            max={72}
            step={1}
            value={hoursText}
            onChange={(e) => setHoursText(e.target.value)}
            aria-invalid={!hoursOk}
          />
          {hoursOk ? (
            <span className="hint">{t('6 to 72. Shorter follows changes faster; longer is steadier.')}</span>
          ) : (
            <span className="field-error">{t('A whole number of hours from 6 to 72')}</span>
          )}
        </label>
      </Choice>

      <Choice
        label={t('Smoothing')}
        value={draft.smoothing}
        onChange={(smoothing) => setDraft({ ...draft, smoothing })}
        options={[
          // i18n: smoothing settings
          { id: 'off', label: t('Off (default)'), hint: t('Every reading as it comes.') },
          { id: 'light', label: tc('smoothing', 'Light'), hint: t('Gravity averaged over the last hour.') },
          { id: 'strong', label: tc('smoothing', 'Strong'), hint: t('Gravity averaged over the last 4 hours.') },
        ]}
      >
        <p className="hint">{t("Averages out wobbles from bubbles and knocks. Used for what's shown, sent and alerted.")}</p>
      </Choice>

      <div className="notice source-note">
        <Icon name="info" />
        <div className="grow">
          <p>
            <strong>{t('What changes')}</strong>
          </p>
          {changes.length > 0 && (
            <ul className="source-changes">
              {changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          <p className="hint">
            {t(
              'Everything that uses the numbers follows: the tiles, the charts (worked out again from the stored readings), brew stats, alerts, webhooks and MQTT. What the pill sent is kept, so you can switch back any time.',
            )}
          </p>
        </div>
      </div>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={busy || !hoursOk || changes.length === 0}
          onClick={() => void save(next, t('Saved'))}
        >
          <Icon name="check" size={16} /> {t('Save')}
        </button>
        {changes.length > 0 && (
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              setDraft(saved);
              setHoursText(String(saved.velocityHours));
              setError(null);
            }}
          >
            {t('Undo')}
          </button>
        )}
        {!isDefault && (
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => void save({ ...DEFAULTS, velocityHours: saved.velocityHours }, t("Back to the pill's own values"))}
          >
            {t("Use the pill's values for everything")}
          </button>
        )}
      </div>
    </section>
  );
}
