import { useState } from 'react';
import { brewPatchSchema, type Brew } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { fromLocalInput, toLocalInput } from '../../format';
import { Modal } from '../../components/ui';
import { FieldError, gravityError, useFormCheck } from '../../validation';
import { t, tk } from '../../i18n';

const EDIT_LABELS = {
  name: tk('Name'),
  style: tk('Style'),
  notes: tk('Notes'),
  og: tk('Original gravity'),
  targetFg: tk('Target FG'),
  startedAt: tk('Started'),
  endedAt: tk('Ended'),
};

export function EditBrewModal({ brew, onClose, onSaved }: { brew: Brew; onClose: () => void; onSaved: (b: Brew) => void }) {
  const u = useUnits();
  const { toast } = useLive();
  // The fields as they opened. The text is rounded (times to the minute), so only fields the user changes are sent:
  // new times also make the hub work out an ended brew's stats again.
  const [initial] = useState(() => {
    const show = (sg: number | null) => (sg === null ? '' : u.gravity === 'plato' ? u.gravityValue(sg).toFixed(1) : sg.toFixed(4));
    return {
      og: show(brew.og),
      fg: show(brew.targetFg),
      start: toLocalInput(brew.startedAt),
      end: brew.endedAt ? toLocalInput(brew.endedAt) : '',
    };
  });
  const [name, setName] = useState(brew.name);
  const [style, setStyle] = useState(brew.style);
  const [og, setOg] = useState(initial.og);
  const [fg, setFg] = useState(initial.fg);
  const [notes, setNotes] = useState(brew.notes);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [busy, setBusy] = useState(false);
  const step = u.gravity === 'plato' ? '0.1' : '0.0001';
  const parseG = (s: string) => (s.trim() === '' ? null : u.gravityFromDisplay(Number(s)));
  const patch = {
    name: name.trim(),
    style: style.trim(),
    notes,
    ...(og !== initial.og ? { og: parseG(og) } : {}),
    ...(fg !== initial.fg ? { targetFg: parseG(fg) } : {}),
    ...(start !== initial.start ? { startedAt: fromLocalInput(start) } : {}),
    ...(brew.endedAt !== null && end && end !== initial.end ? { endedAt: fromLocalInput(end) } : {}),
  };
  const check = useFormCheck(brewPatchSchema, patch, EDIT_LABELS);
  const { errors } = check;

  return (
    <Modal title={t('Edit brew')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!check.ok(t("Couldn't save"))) return;
          setBusy(true);
          try {
            const saved = await api.updateBrew(brew.id, patch);
            onSaved(saved);
            onClose();
          } catch (err) {
            toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>{t('Name')}</span>
          <input className="input" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <FieldError error={errors.name} />
        </label>
        <label className="field">
          <span>{t('Style')}</span>
          <input className="input" maxLength={100} value={style} onChange={(e) => setStyle(e.target.value)} />
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
              placeholder={t('Auto')}
            />
            <FieldError error={gravityError(errors.og, parseG(og), u.gravityText)} />
          </label>
          <label className="field">
            <span>{t('Target FG ({unit})', { unit: u.gravityLabel })}</span>
            <input className="input num" type="number" step={step} value={fg} onChange={(e) => setFg(e.target.value)} />
            <FieldError error={gravityError(errors.targetFg, parseG(fg), u.gravityText)} />
          </label>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          {t(
            'Leave the OG empty to take it from the pill: the middle reading from its first to third hour in the wort, once it has settled.',
          )}
        </p>
        <div className="form-grid">
          <label className="field">
            <span>{t('Started')}</span>
            <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            <FieldError error={errors.startedAt && tk('Pick a date and time')} />
          </label>
          {brew.endedAt !== null && (
            <label className="field">
              <span>{t('Ended')}</span>
              <input className="input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
              <FieldError error={errors.endedAt && tk('Pick a date and time')} />
            </label>
          )}
        </div>
        <label className="field">
          <span>{t('Notes')}</span>
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <FieldError error={errors.notes} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {t('Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
