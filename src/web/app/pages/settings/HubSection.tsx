import { useEffect, useId, useState, type FormEvent } from 'react';
import { ABV_FORMULAS, hubSettingsSchema, type GravityUnit, type HubSettings, type TemperatureUnit } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { LOCALES, t, tk, useI18n, type LocaleId } from '../../i18n';
import { UnitSource, UnitToggles } from '../../units';
import { FieldError, useFormCheck } from '../../validation';
import { Icon } from '../../components/Icon';
import { OwnerOnly, Switch } from '../../components/ui';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { PalettePicker } from '../../components/PalettePicker';

const GRAVITY: { id: GravityUnit; label: string; name: string }[] = [
  { id: 'sg', label: 'SG', name: tk('SG, specific gravity') },
  { id: 'plato', label: '°P', name: tk('°P, degrees Plato') },
];
const TEMPERATURE: { id: TemperatureUnit; label: string; name: string }[] = [
  { id: 'C', label: '°C', name: tk('°C, Celsius') },
  { id: 'F', label: '°F', name: tk('°F, Fahrenheit') },
];

/** The hub's name, default units, ABV formula and update checks (owner only), plus this browser's own display choices. */
export function HubSection() {
  const { hub, isOwner, toast } = useLive();
  const { choice, setLocale } = useI18n();
  // One state, so following the hub (below) sees an edit queued just before it, instead of the value it was scheduled with.
  const [form, setForm] = useState<{ draft: HubSettings; dirty: boolean }>({ draft: hub, dirty: false });
  const { draft, dirty } = form;
  const [busy, setBusy] = useState(false);
  const { errors, ok } = useFormCheck(hubSettingsSchema, draft, { name: tk('the hub name') });
  const id = useId();

  // Follow changes made elsewhere, unless they'd overwrite an edit in progress.
  useEffect(() => {
    setForm((f) => (f.dirty ? f : { draft: hub, dirty: false }));
  }, [hub]);

  const edit = (patch: Partial<HubSettings>) => {
    setForm((f) => ({ draft: { ...f.draft, ...patch }, dirty: true }));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok(t("Couldn't save the hub settings"))) return;
    setBusy(true);
    try {
      setForm({ draft: await api.saveHub({ ...draft, name: draft.name.trim() }), dirty: false });
      toast({ tone: 'success', title: t('Hub settings saved') });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save the hub settings"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const locked = !isOwner || busy;
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <div className="panel-head">
        <div>
          <h2 id={`${id}-title`}>
            <Icon name="sliders" /> {t('Hub')}
          </h2>
          <p>{t('Settings for everyone who uses this hub.')}</p>
        </div>
      </div>

      <form className="stack" onSubmit={save}>
        <label className="field" style={{ maxWidth: '24rem' }}>
          <span>{t('Hub name')}</span>
          <input
            className="input"
            value={draft.name}
            maxLength={40}
            disabled={locked}
            onChange={(e) => edit({ name: e.target.value })}
            aria-invalid={Boolean(errors.name)}
          />
          <FieldError error={errors.name} />
          <span className="hint">{t('Shown in the top bar and the browser tab.')}</span>
        </label>

        <fieldset className="fieldset">
          <legend>{t('Default units')}</legend>
          <div className="row">
            <div className="segmented" role="group" aria-label={t('Default gravity unit')}>
              {GRAVITY.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  disabled={locked}
                  className={draft.units.gravity === g.id ? 'on' : ''}
                  aria-pressed={draft.units.gravity === g.id}
                  aria-label={t(g.name)}
                  onClick={() => edit({ units: { ...draft.units, gravity: g.id } })}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <div className="segmented" role="group" aria-label={t('Default temperature unit')}>
              {TEMPERATURE.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  disabled={locked}
                  className={draft.units.temperature === u.id ? 'on' : ''}
                  aria-pressed={draft.units.temperature === u.id}
                  aria-label={t(u.name)}
                  onClick={() => edit({ units: { ...draft.units, temperature: u.id } })}
                >
                  {u.label}
                </button>
              ))}
            </div>
          </div>
          <p className="hint">
            {t(
              "Used in notifications, and by every browser that hasn't picked its own units. A browser's own choice (below, or in the top bar) stays with that browser.",
            )}
          </p>
        </fieldset>

        <fieldset className="fieldset">
          <legend>{t('ABV formula')}</legend>
          <div className="choice-list">
            {ABV_FORMULAS.map((f) => (
              <label key={f.id} className={`choice${draft.abvFormula === f.id ? ' on' : ''}`}>
                <input
                  type="radio"
                  name={`${id}-abv`}
                  value={f.id}
                  checked={draft.abvFormula === f.id}
                  disabled={locked}
                  onChange={() => edit({ abvFormula: f.id })}
                />
                <span>
                  <strong>{t(f.label)}</strong>
                  <code className="formula">ABV = {f.formula}</code>
                </span>
              </label>
            ))}
          </div>
          <p className="hint">
            {t('How alcohol by volume is worked out from the original gravity (OG) and the current or final gravity (FG).')}
          </p>
        </fieldset>

        <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <Switch
            on={draft.updateCheck}
            disabled={locked}
            label={t('Check for updates daily')}
            onChange={(on) => edit({ updateCheck: on })}
          />
          <div>
            <strong>{t('Check for updates daily')}</strong>
            <p className="hint">{t("Asks GitHub once a day whether there's a newer RaptHooker. Nothing about your brews is sent.")}</p>
          </div>
        </div>

        {isOwner ? (
          <div className="row">
            <button type="submit" className="btn primary" disabled={busy || !dirty}>
              <Icon name="check" /> {t('Save')}
            </button>
            {dirty && (
              <button type="button" className="btn ghost" onClick={() => setForm({ draft: hub, dirty: false })}>
                <Icon name="undo" size={16} /> {t('Undo changes')}
              </button>
            )}
          </div>
        ) : (
          <OwnerOnly isOwner={false}>{null}</OwnerOnly>
        )}
      </form>

      <hr className="divider" />
      <h3 className="subhead">{t('This browser')}</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        {t('Only for this browser on this device. Nothing here changes the hub.')}
      </p>
      <div className="form-grid" style={{ marginTop: '0.8rem' }}>
        <div className="field">
          <span className="label">{t('Units')}</span>
          <UnitToggles />
          <UnitSource />
        </div>
        <div className="field">
          <span className="label">{t('Theme')}</span>
          <ThemeSwitch />
          <span className="hint">{t("Auto follows your device's light or dark setting.")}</span>
        </div>
        <div className="field">
          <span className="label">{t('Colours')}</span>
          <PalettePicker />
          <span className="hint">{t('Each comes in a dark and a light version, following the theme.')}</span>
        </div>
        <label className="field">
          <span className="label">{t('Language')}</span>
          <select className="select" value={choice ?? ''} onChange={(e) => setLocale((e.target.value || null) as LocaleId | null)}>
            <option value="">{t('Automatic (browser)')}</option>
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id} lang={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
