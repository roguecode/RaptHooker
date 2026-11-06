import { useEffect, useState } from 'react';
import { DEFAULT_VESSEL, servingUnitSchema, vesselSchema, type Pill, type ServingUnit, type Vessel } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { scaleOf, useUnits, volumeIn } from '../../units';
import { fixed } from '../../format';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n';
import { vesselOf } from '../devices/keg';

const text = (v: Vessel) => ({ capacity: String(v.capacity), emptyMm: String(v.emptyMm), fullMm: String(v.fullMm) });

/**
 * The keg under a RAPT Laser Level: how much it holds, and how far down the beer is when it's empty and when it's full.
 * The distances can be taken from its latest reading (with the keg empty, or just filled).
 */
export function VesselSettings({ pill }: { pill: Pill }) {
  const { toast, upsertPill } = useLive();
  const saved = vesselOf(pill);
  const [draft, setDraft] = useState(() => text(saved));
  const [busy, setBusy] = useState(false);
  const distance = pill.live.latest?.distance ?? null;
  const savedKey = `${saved.capacity}|${saved.emptyMm}|${saved.fullMm}`;
  // Another browser may change it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(text(saved)), [savedKey]);

  const parsed = vesselSchema.safeParse({ capacity: Number(draft.capacity), emptyMm: Number(draft.emptyMm), fullMm: Number(draft.fullMm) });
  const changed = parsed.success && `${parsed.data.capacity}|${parsed.data.emptyMm}|${parsed.data.fullMm}` !== savedKey;

  const save = async (vessel: Vessel) => {
    setBusy(true);
    try {
      upsertPill(await api.updatePill(pill.id, { vessel }));
      toast({ tone: 'success', title: t('Keg saved') });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.success) void save(parsed.data);
      }}
    >
      <h3 className="row" style={{ margin: 0 }}>
        <Icon name="beer" size={16} /> {t('The keg')}
      </h3>
      <p className="hint" style={{ margin: 0 }}>
        {t(
          'How full the keg is comes from how far down the beer is. A keg with straight sides is assumed. Changing these changes how full it was, everywhere, as nothing but the distance is stored.',
        )}
      </p>
      <div className="form-grid">
        <label className="field">
          <span>{t('Holds (litres)')}</span>
          <input
            className="input num"
            type="number"
            step="0.1"
            min={0.1}
            value={draft.capacity}
            onChange={(e) => setDraft({ ...draft, capacity: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t('Empty: down to the bottom (mm)')}</span>
          <input
            className="input num"
            type="number"
            step="1"
            min={10}
            max={6000}
            value={draft.emptyMm}
            onChange={(e) => setDraft({ ...draft, emptyMm: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t('Full: down to the beer (mm)')}</span>
          <input
            className="input num"
            type="number"
            step="1"
            min={0}
            max={5990}
            value={draft.fullMm}
            onChange={(e) => setDraft({ ...draft, fullMm: e.target.value })}
          />
        </label>
      </div>
      {!parsed.success && (
        <p className="hint" role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
          {t('Empty has to be further down than full.')}
        </p>
      )}
      <p className="hint" style={{ margin: 0 }}>
        {t("KegLand's figures for a 19 L keg are 560 mm and 26 mm, and 290 mm for a 9.5 L one.")}{' '}
        {distance !== null && t('Right now it reads {mm} mm.', { mm: fixed(distance, 0) })}
      </p>
      <div className="row">
        <button type="submit" className="btn" disabled={busy || !changed}>
          {t('Save keg')}
        </button>
        {distance !== null && (
          <>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => setDraft({ ...draft, emptyMm: String(Math.round(distance)) })}
              title={t('With the keg empty: use what it reads now as empty')}
            >
              {t('It’s empty now')}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => setDraft({ ...draft, fullMm: String(Math.round(distance)) })}
              title={t('With the keg just filled: use what it reads now as full')}
            >
              {t('It’s full now')}
            </button>
          </>
        )}
        <button type="button" className="btn ghost" disabled={busy} onClick={() => setDraft(text(DEFAULT_VESSEL))}>
          {t('19 L keg')}
        </button>
      </div>
    </form>
  );
}

/**
 * A Laser Level's own unit ("cans" of 330 ml): with "Custom" picked as the volume unit, how much is left is counted in
 * it. It's only for showing; the hub keeps litres.
 */
export function ServingUnitSettings({ pill }: { pill: Pill }) {
  const { toast, upsertPill } = useLive();
  const u = useUnits();
  const saved = pill.servingUnit ?? null;
  const [ml, setMl] = useState(saved ? String(saved.ml) : '');
  const [name, setName] = useState(saved?.name ?? '');
  const [busy, setBusy] = useState(false);
  const savedKey = saved ? `${saved.ml}|${saved.name}` : '';
  useEffect(() => {
    setMl(saved ? String(saved.ml) : '');
    setName(saved?.name ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const parsed = servingUnitSchema.safeParse({ ml: Number(ml), name });
  const changed = parsed.success && `${parsed.data.ml}|${parsed.data.name}` !== savedKey;
  const volume = pill.live.latest?.volume ?? null;

  const save = async (servingUnit: ServingUnit | null) => {
    setBusy(true);
    try {
      upsertPill(await api.updatePill(pill.id, { servingUnit }));
      toast({ tone: 'success', title: servingUnit ? t('Unit saved') : t('Unit removed') });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.success) void save(parsed.data);
      }}
    >
      <h3 className="row" style={{ margin: 0 }}>
        <Icon name="beer" size={16} /> {t('Your own unit')}
      </h3>
      <p className="hint" style={{ margin: 0 }}>
        {t(
          'Count what’s left in something of your own, like 330 ml cans or 425 ml glasses. It’s used when Custom is picked as the volume unit, next to °C and °F.',
        )}
      </p>
      <div className="form-grid">
        <label className="field">
          <span>{t('Size (ml)')}</span>
          <input
            className="input num"
            type="number"
            step="1"
            min={1}
            max={100000}
            value={ml}
            onChange={(e) => setMl(e.target.value)}
            placeholder="330"
          />
        </label>
        <label className="field">
          <span>{t('Called')}</span>
          <input className="input" maxLength={20} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('cans')} />
        </label>
      </div>
      {parsed.success && volume !== null && (
        <p className="hint" style={{ margin: 0 }}>
          {t('Right now that’s {amount}.', { amount: volumeIn(scaleOf('custom', parsed.data), volume) })}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn" disabled={busy || !changed}>
          {t('Save unit')}
        </button>
        {saved && (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void save(null)}>
            {t('Remove unit')}
          </button>
        )}
        {saved && u.volume !== 'custom' && (
          <button type="button" className="btn ghost" onClick={() => u.setVolume('custom')}>
            {t('Show it in {unit} here', { unit: saved.name })}
          </button>
        )}
      </div>
    </form>
  );
}
