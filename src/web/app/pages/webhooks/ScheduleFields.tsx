import { useState } from 'react';
import { presetById } from '@rapthooker/shared';
import { useLive } from '../../live';
import { t } from '../../i18n';
import { FieldError } from '../../validation';
import { NumberInput } from '../../components/NumberInput';
import type { FieldsProps } from './RequestFields';

const nullableNumber = (value: string): number | null => (value.trim() === '' ? null : Number(value));

/** "Only send when something changes": gravity and temperature thresholds, and the longest silence allowed. */
function ChangeFields({ draft, set, errors }: FieldsProps) {
  const [on, setOn] = useState(draft.minChangeGravity !== null || draft.minChangeTemp !== null);
  const f = draft.temperatureUnit === 'F';
  const toUnit = (c: number) => Math.round(c * (f ? 1.8 : 1) * 100) / 100;
  const fromUnit = (v: number) => Math.round((v / (f ? 1.8 : 1)) * 1000) / 1000;
  const toggle = (checked: boolean) => {
    setOn(checked);
    set('minChangeGravity', checked ? 1 : null);
    set('minChangeTemp', checked ? 0.5 : null);
    set('maxSilenceMin', checked ? 240 : null);
  };

  return (
    <div className="option-group">
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
        <span>
          {t('Only send when something changes')}
          <small>
            {t(
              'Hold a reading back unless the gravity or the temperature has moved this much since the last one sent. The interval above still applies.',
            )}
          </small>
        </span>
      </label>
      {on && (
        <>
          <div className="inline-fields">
            <label className="field">
              {/* i18n: the three boxes read as one sentence: "Gravity moved at least [1] points, or the temperature [0.5] °C, but send at least every [240] minutes" */}
              <span>{t('Gravity moved at least')}</span>
              <div className="row">
                <input
                  className="input num"
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={draft.minChangeGravity ?? ''}
                  onChange={(e) => set('minChangeGravity', nullableNumber(e.target.value))}
                />
                <span className="muted small">{t('points')}</span>
              </div>
              <FieldError error={errors.minChangeGravity} />
            </label>
            <label className="field">
              <span>{t('or the temperature')}</span>
              <div className="row">
                <input
                  className="input num"
                  type="number"
                  min={0}
                  step={0.1}
                  value={draft.minChangeTemp === null ? '' : toUnit(draft.minChangeTemp)}
                  onChange={(e) => {
                    const v = nullableNumber(e.target.value);
                    set('minChangeTemp', v === null ? null : fromUnit(v));
                  }}
                />
                <span className="muted small">°{draft.temperatureUnit}</span>
              </div>
              <FieldError error={errors.minChangeTemp} />
            </label>
            <label className="field">
              <span>{t('But send at least every')}</span>
              <div className="row">
                <input
                  className="input num"
                  type="number"
                  min={1}
                  max={10080}
                  value={draft.maxSilenceMin ?? ''}
                  onChange={(e) => set('maxSilenceMin', nullableNumber(e.target.value))}
                />
                <span className="muted small">{t('minutes')}</span>
              </div>
              <FieldError error={errors.maxSilenceMin} />
            </label>
          </div>
          <span className="hint" style={{ paddingLeft: '1.6rem' }}>
            {t('1 point is 0.001 SG (1.050 → 1.049). Leave a box empty to ignore it.')}
          </span>
        </>
      )}
    </div>
  );
}

/** How often the webhook sends, for which pills and in which units. */
export function ScheduleFields({ draft, set, errors }: FieldsProps) {
  const { pills } = useLive();
  const preset = presetById(draft.preset);
  const activePills = pills.filter((p) => !p.archived);
  const tooOften = preset?.minIntervalMin != null && draft.intervalMin < preset.minIntervalMin;
  const pillsError = Object.entries(errors).find(([k]) => k === 'pillIds' || k.startsWith('pillIds.'))?.[1];

  return (
    <section className="panel stack">
      <h3 style={{ margin: 0 }}>{t('When and what')}</h3>
      <div className="field">
        <span>{t('Send every')}</span>
        <div className="row">
          <NumberInput
            className="input num"
            style={{ width: '6rem' }}
            min={1}
            max={10080}
            fallback={15}
            value={draft.intervalMin}
            onValue={(v) => set('intervalMin', v)}
          />
          <span className="muted">{t('minutes')}</span>
          <div className="chips">
            {[5, 15, 30, 60, 240].map((m) => (
              <button key={m} type="button" className={`chip${draft.intervalMin === m ? ' on' : ''}`} onClick={() => set('intervalMin', m)}>
                {m >= 60 ? t('{count} h', { count: m / 60 }) : t('{count} min', { count: m })}
              </button>
            ))}
          </div>
        </div>
        <FieldError error={errors.intervalMin} />
        {tooOften && (
          <span className="hint" style={{ color: 'var(--warning)' }}>
            {t('{name} ignores anything sent more often than every {minutes} minutes.', {
              name: preset!.name,
              minutes: preset!.minIntervalMin!,
            })}
          </span>
        )}
      </div>
      <div className="field">
        <span>{t('Pills')}</span>
        <label className="check">
          <input type="radio" checked={draft.pillIds === 'all'} onChange={() => set('pillIds', 'all')} />
          <span>
            {t('All pills')}
            <small>
              {t('Including any you add later.')} {draft.batch ? t('They all go in one request.') : t('Each pill is sent separately.')}
            </small>
          </span>
        </label>
        <label className="check">
          <input
            type="radio"
            checked={draft.pillIds !== 'all'}
            onChange={() =>
              set(
                'pillIds',
                activePills.map((p) => p.id),
              )
            }
          />
          <span>{t('Only these:')}</span>
        </label>
        {draft.pillIds !== 'all' && (
          <div className="chips" style={{ paddingLeft: '1.6rem' }}>
            {activePills.length === 0 && <span className="muted small">{t('No pills yet.')}</span>}
            {activePills.map((p) => {
              const ids = draft.pillIds as string[];
              const on = ids.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`chip${on ? ' on' : ''}`}
                  onClick={() => set('pillIds', on ? ids.filter((x) => x !== p.id) : [...ids, p.id])}
                >
                  <span className="swatch" style={{ background: p.color }} /> {p.name}
                </button>
              );
            })}
          </div>
        )}
        <FieldError error={pillsError} />
      </div>
      <label className="check">
        <input type="checkbox" checked={draft.onlyDuringBrew} onChange={(e) => set('onlyDuringBrew', e.target.checked)} />
        <span>
          {t('Only while a brew is running')}
          <small>{t('Stay quiet when a pill is just sitting in a cupboard.')}</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.onlyNewReadings} onChange={(e) => set('onlyNewReadings', e.target.checked)} />
        <span>
          {t('Only send new readings')}
          <small>{t("Skip a send if the pill hasn't reported since the last one (e.g. it's out of range).")}</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.skipImplausible} onChange={(e) => set('skipImplausible', e.target.checked)} />
        <span>
          {t("Don't send readings that look wrong")}
          <small>
            {t(
              "When a pill doesn't look like it's floating (lying on its side, or a gravity no beer could have), its reading is held back. It isn't counted as a failure.",
            )}
          </small>
        </span>
      </label>
      <ChangeFields draft={draft} set={set} errors={errors} />
      <label className="check">
        <input type="checkbox" checked={draft.catchUp} onChange={(e) => set('catchUp', e.target.checked)} />
        <span>
          {t('Catch up after an outage')}
          <small>
            {t(
              "When the destination couldn't be reached (or the hub lost its internet), send the readings it missed once it works again: oldest first, one per interval, up to 10 a minute and 7 days back. Many services (Brewfather, Brewer's Friend, Grainfather…) ignore or reject old readings or more than one every 15 minutes, so leave this off for them unless you know they cope.",
            )}
          </small>
        </span>
      </label>
      <div className="row">
        <div className="field">
          <span>{t('Gravity unit')}</span>
          <div className="segmented">
            <button type="button" className={draft.gravityUnit === 'sg' ? 'on' : ''} onClick={() => set('gravityUnit', 'sg')}>
              SG
            </button>
            <button type="button" className={draft.gravityUnit === 'plato' ? 'on' : ''} onClick={() => set('gravityUnit', 'plato')}>
              °Plato
            </button>
          </div>
        </div>
        <div className="field">
          <span>{t('Temperature unit')}</span>
          <div className="segmented">
            <button type="button" className={draft.temperatureUnit === 'C' ? 'on' : ''} onClick={() => set('temperatureUnit', 'C')}>
              °C
            </button>
            <button type="button" className={draft.temperatureUnit === 'F' ? 'on' : ''} onClick={() => set('temperatureUnit', 'F')}>
              °F
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
