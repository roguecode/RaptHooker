import { useState } from 'react';
import { startBrewSchema, type Pill } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { fromLocalInput, toLocalInput } from '../../format';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { FieldError, gravityError, useFormCheck } from '../../validation';
import { t, tk } from '../../i18n';

const LABELS = {
  name: tk('Name'),
  style: tk('Style'),
  notes: tk('Notes'),
  og: tk('Original gravity'),
  targetFg: tk('Target final gravity'),
  startedAt: tk('Started at'),
};

export function StartBrewModal({ pill, onClose }: { pill: Pill; onClose: () => void }) {
  const u = useUnits();
  const { toast } = useLive();
  const [name, setName] = useState('');
  const [style, setStyle] = useState('');
  const [og, setOg] = useState('');
  const [fg, setFg] = useState('');
  const [notes, setNotes] = useState('');
  const [backdate, setBackdate] = useState(false);
  const [startedAt, setStartedAt] = useState(toLocalInput(Date.now() - 3_600_000));
  const [busy, setBusy] = useState(false);
  const step = u.gravity === 'plato' ? '0.1' : '0.001';
  const parseG = (s: string) => (s.trim() === '' ? null : u.gravityFromDisplay(Number(s)));
  const body = {
    pillId: pill.id,
    name: name.trim(),
    style: style.trim(),
    notes,
    og: parseG(og),
    targetFg: parseG(fg),
    startedAt: backdate ? fromLocalInput(startedAt) : undefined,
  };
  const check = useFormCheck(startBrewSchema, body, LABELS);
  const { errors } = check;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!check.ok(t("Couldn't start the brew"))) return;
    setBusy(true);
    try {
      const { pillId, ...input } = body;
      const brew = await api.startBrew(pillId, input);
      toast({ tone: 'success', title: t('{name} started', { name: brew.name }), body: t('Cheers! 🍻') });
      onClose();
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't start the brew"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Start a brew')} onClose={onClose}>
      <p className="muted small">
        {t('On {pill}. Readings are already being recorded, so you can start a brew any time, even after pitching.', { pill: pill.name })}
      </p>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>{t('Name')}</span>
          <input
            className="input"
            required
            maxLength={100}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Hazy IPA #4"
          />
          <FieldError error={errors.name} />
        </label>
        <label className="field">
          <span>{t('Style')}</span>
          <input className="input" maxLength={100} value={style} onChange={(e) => setStyle(e.target.value)} placeholder="New England IPA" />
          <FieldError error={errors.style} />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>{t('Original gravity ({unit})', { unit: u.gravityLabel })}</span>
            <input
              className="input num"
              type="number"
              step={step}
              value={og}
              onChange={(e) => setOg(e.target.value)}
              placeholder={t('Auto from the pill')}
            />
            <FieldError error={gravityError(errors.og, body.og, u.gravityText)} />
          </label>
          <label className="field">
            <span>{t('Target final gravity ({unit})', { unit: u.gravityLabel })}</span>
            <input
              className="input num"
              type="number"
              step={step}
              value={fg}
              onChange={(e) => setFg(e.target.value)}
              placeholder={u.gravity === 'plato' ? '2.5' : '1.012'}
            />
            <FieldError error={gravityError(errors.targetFg, body.targetFg, u.gravityText)} />
          </label>
        </div>
        {!og.trim() && (
          <p className="hint" style={{ margin: 0 }}>
            {t(
              'With no OG, RaptHooker takes it from the pill once it has settled: the middle reading from its first to third hour in the wort.',
            )}
          </p>
        )}
        <label className="check">
          <input type="checkbox" checked={backdate} onChange={(e) => setBackdate(e.target.checked)} />
          <span>
            {t('It started earlier')}
            <small>{t('Include readings already recorded since then.')}</small>
          </span>
        </label>
        {backdate && (
          <label className="field">
            <span>{t('Started at')}</span>
            <input
              className="input"
              type="datetime-local"
              value={startedAt}
              max={toLocalInput(Date.now())}
              onChange={(e) => setStartedAt(e.target.value)}
            />
            <FieldError error={errors.startedAt && tk('Pick a date and time')} />
          </label>
        )}
        <label className="field">
          <span>{t('Notes')}</span>
          <textarea
            className="textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('Yeast, hops, dry hop schedule…')}
          />
          <FieldError error={errors.notes} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            <Icon name="play" size={16} /> {t('Start brew')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
