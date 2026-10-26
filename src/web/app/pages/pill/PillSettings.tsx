import { useEffect, useState } from 'react';
import { PILL_COLORS, temperatureDeltaIn, type Pill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { navigate } from '../../router';
import { Icon } from '../../components/Icon';
import { Confirm } from '../../components/ui';
import { t } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { CalibrationWizard, type CalibrationStep } from './CalibrationWizard';
import { DataSources } from './DataSources';
import './pill.css';

export function PillSettings({ pill }: { pill: Pill }) {
  const u = useUnits();
  const { toast, upsertPill } = useLive();
  const tempUnit = u.temperature;
  const thermometer = pill.kind === 'thermometer';
  // The offsets as the boxes show them: rounded, so an offset whose box wasn't touched is saved as it was.
  const shownG = String(Math.round(pill.offsets.gravity * 10000) / 10);
  const shownT = String(Math.round(temperatureDeltaIn(pill.offsets.temperature, tempUnit) * 100) / 100);
  const [name, setName] = useState(pill.name);
  const [gOff, setGOff] = useState(shownG);
  const [tOff, setTOff] = useState(shownT);
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);
  const [wizard, setWizard] = useState<CalibrationStep | null>(null);

  // The wizard (or another browser) can change the offsets.
  useEffect(() => setGOff(shownG), [shownG]);
  useEffect(() => setTOff(shownT), [shownT]);

  const save = async (patch: Parameters<typeof api.updatePill>[1], message?: string) => {
    try {
      upsertPill(await api.updatePill(pill.id, patch));
      if (message) toast({ tone: 'success', title: message });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="sliders" /> {thermometer ? t('Thermometer settings') : t('Pill settings')}
          </h2>
        </div>
      </div>
      <div className="grid two">
        <div className="stack">
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void save({ name: name.trim() }, t('Renamed'));
            }}
          >
            <span>{t('Name')}</span>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              <button type="submit" className="btn" disabled={!name.trim() || name.trim() === pill.name}>
                {t('Save')}
              </button>
            </div>
            <span className="hint">{t('Webhooks send this name, and services like Brewfather use it to tell devices apart.')}</span>
          </form>
          <div className="field">
            <span>{t('Colour')}</span>
            <div className="color-swatches">
              {PILL_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  className={c === pill.color ? 'on' : ''}
                  style={{ background: c }}
                  onClick={() => void save({ color: c })}
                />
              ))}
            </div>
          </div>
        </div>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const g = gOff === shownG ? pill.offsets.gravity : Number(gOff) / 1000;
            const temp = tOff === shownT ? pill.offsets.temperature : tempUnit === 'F' ? (Number(tOff) * 5) / 9 : Number(tOff);
            if (!Number.isFinite(g) || !Number.isFinite(temp)) return;
            void save({ offsets: { gravity: g, temperature: temp } }, t('Calibration saved'));
          }}
        >
          <div className="form-grid">
            {!thermometer && (
              <label className="field">
                <span>{t('Gravity offset (points)')}</span>
                <input
                  className="input num"
                  type="number"
                  step="0.1"
                  min={-50}
                  max={50}
                  value={gOff}
                  onChange={(e) => setGOff(e.target.value)}
                />
              </label>
            )}
            <label className="field">
              <span>{t('Temperature offset ({unit})', { unit: u.tempLabel })}</span>
              <input
                className="input num"
                type="number"
                step="0.1"
                min={u.temperature === 'F' ? -18 : -10}
                max={u.temperature === 'F' ? 18 : 10}
                value={tOff}
                onChange={(e) => setTOff(e.target.value)}
              />
            </label>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            {thermometer
              ? t('Added to every reading, including history and webhooks.')
              : t(
                  'Added to every reading, including history and webhooks. 1 point = 0.001 SG, so −2 turns 1.012 into 1.010. Calibrate the pill in the RAPT app first; this is for fine-tuning.',
                )}
          </p>
          <div className="row">
            <button type="submit" className="btn">
              {t('Save calibration')}
            </button>
            {!thermometer && (
              <button type="button" className="btn ghost" onClick={() => setWizard('water')}>
                <Icon name="flask" size={16} /> {t('Calibration wizard')}
              </button>
            )}
          </div>
        </form>
      </div>
      {!thermometer && (
        <>
          <hr className="divider" />
          <DataSources pill={pill} onCalibrateTilt={() => setWizard('tilt')} />
        </>
      )}
      <hr className="divider" />
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={() => (pill.archived ? void save({ archived: false }, t('Recording again')) : setConfirm('archive'))}
        >
          <Icon name={pill.archived ? 'play' : 'archive'} size={16} /> {pill.archived ? t('Start recording again') : t('Archive')}
        </button>
        <button type="button" className="btn danger" onClick={() => setConfirm('delete')}>
          <Icon name="trash" size={16} /> {thermometer ? t('Remove thermometer') : t('Remove pill')}
        </button>
      </div>
      {wizard && <CalibrationWizard pillId={pill.id} step={wizard} onClose={() => setWizard(null)} />}
      {confirm === 'archive' && (
        <Confirm
          title={t('Archive {name}?', { name: pill.name })}
          body={
            <p>
              {t(
                'It stops being recorded and is hidden from the dashboard. Its history and brews are kept, and you can start recording again from here.',
              )}
            </p>
          }
          confirm={t('Archive')}
          onClose={() => setConfirm(null)}
          onConfirm={() => save({ archived: true }, t('Archived'))}
        />
      )}
      {confirm === 'delete' && (
        <Confirm
          title={t('Remove {name}?', { name: pill.name })}
          body={
            <p>
              {thermometer ? (
                <Trans
                  text={t("This deletes {what}. This can't be undone. (To keep them, archive the thermometer instead.)")}
                  values={{ what: <strong>{t('all of its readings')}</strong> }}
                />
              ) : (
                <Trans
                  text={t("This deletes {what}. This can't be undone. (To keep them, archive the pill instead.)")}
                  values={{ what: <strong>{t('all of its readings and brews')}</strong> }}
                />
              )}
            </p>
          }
          confirm={t('Delete everything')}
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await api.deletePill(pill.id);
              toast({ tone: 'success', title: t('{name} removed', { name: pill.name }) });
              navigate('#/');
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't remove it"), body: errorText(err) });
            }
          }}
        />
      )}
    </section>
  );
}
