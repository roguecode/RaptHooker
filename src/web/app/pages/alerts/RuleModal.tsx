import { useState } from 'react';
import { ALERT_KINDS, alertInputSchema, alertKindInfo, BROWSER_PUSH, type AlertRuleInput, type Channel } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { Modal } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { FieldError, useFormCheck } from '../../validation';
import { currentLocale, t, tk } from '../../i18n';
import { ChannelIcon } from './ChannelIcon';

export const emptyRule = (): AlertRuleInput => ({
  name: t('Too warm'),
  enabled: true,
  pillIds: 'all',
  kind: 'temp_above',
  threshold: 24,
  hours: 48,
  onlyDuringBrew: true,
  cooldownMin: 60,
  channelIds: 'all',
});

/** Where a rule's alerts go, in words. */
export function sendToText(channelIds: AlertRuleInput['channelIds'], channels: Channel[]): string {
  if (channelIds === 'all') return t('everywhere');
  const names = channelIds
    .map((id) => (id === BROWSER_PUSH ? t('browser notifications') : channels.find((c) => c.id === id)?.name))
    .filter((n): n is string => !!n);
  return names.length ? names.join(', ') : t('only in this app');
}

/** An alert kind's description to follow its label ("Temperature above: the beer gets too warm"). */
function describeAfterLabel(describe: string): string {
  const text = t(describe);
  // English lower-cases it after the colon; other languages keep the translator's capitals (nouns in German, say).
  return currentLocale() === 'en' ? text.toLowerCase() : text;
}

function SendTo({
  value,
  channels,
  onChange,
}: {
  value: AlertRuleInput['channelIds'];
  channels: Channel[];
  onChange: (v: AlertRuleInput['channelIds']) => void;
}) {
  const ids = value === 'all' ? [] : value;
  const toggle = (id: string) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const options = [
    { id: BROWSER_PUSH, name: t('Browser notifications'), kind: 'browser' as const, enabled: true },
    ...channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind, enabled: c.enabled })),
  ];
  return (
    <div className="field">
      <span>{t('Send to')}</span>
      <div className="chips">
        <button
          type="button"
          className={`chip${value === 'all' ? ' on' : ''}`}
          aria-pressed={value === 'all'}
          onClick={() => onChange('all')}
        >
          {t('Everywhere')}
        </button>
        {options.map((o) => {
          const on = ids.includes(o.id);
          return (
            <button key={o.id} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(o.id)}>
              <ChannelIcon kind={o.kind} size={14} /> {o.name}
              {!o.enabled && <span className="faint"> {t('(off)')}</span>}
            </button>
          );
        })}
      </div>
      <span className="hint">
        {value === 'all'
          ? t('Browser notifications and every service under "Where alerts go" that is switched on.')
          : ids.length === 0
            ? t('Only shown in this app.')
            : t('Alerts always show in this app too.')}
      </span>
    </div>
  );
}

export function RuleModal({
  isNew,
  initial,
  channels,
  onClose,
  onSave,
}: {
  isNew: boolean;
  initial: AlertRuleInput;
  channels: Channel[];
  onClose: () => void;
  onSave: (r: AlertRuleInput) => Promise<void>;
}) {
  const u = useUnits();
  const { pills, toast } = useLive();
  const [rule, setRule] = useState(initial);
  const info = alertKindInfo(rule.kind);
  const toDisplay = (v: number) =>
    info.measure === 'temperature'
      ? Math.round(u.tempValue(v) * 10) / 10
      : info.measure === 'gravity'
        ? u.gravity === 'plato'
          ? Math.round(u.gravityValue(v) * 10) / 10
          : v
        : v;
  const [threshold, setThreshold] = useState(String(toDisplay(rule.threshold)));
  const [busy, setBusy] = useState(false);
  const unit = { temperature: u.tempLabel, gravity: u.gravityLabel, points: t('points'), percent: '%', minutes: t('minutes') }[
    info.measure
  ];
  const thresholdLabel =
    info.measure === 'points' ? tk('Changed less than') : info.measure === 'minutes' ? tk('Quiet for') : tk('Threshold');
  const n = Number(threshold);
  const input = {
    ...rule,
    // The box shows the threshold rounded: one that wasn't changed is saved as it was.
    threshold:
      threshold === String(toDisplay(rule.threshold))
        ? rule.threshold
        : info.measure === 'temperature'
          ? u.tempFromDisplay(n)
          : info.measure === 'gravity'
            ? u.gravityFromDisplay(n)
            : n,
  };
  const check = useFormCheck(alertInputSchema, input, {
    name: tk('Name'),
    kind: tk('When'),
    threshold: thresholdLabel,
    hours: tk('Over (hours)'),
    cooldownMin: tk("Don't repeat for"),
    pillIds: tk('Pills'),
    channelIds: tk('Send to'),
  });
  const { errors } = check;

  const changeKind = (kind: AlertRuleInput['kind']) => {
    const k = alertKindInfo(kind);
    const def = k.defaultThreshold;
    setRule((r) => ({ ...r, kind, name: t(k.label), threshold: def }));
    setThreshold(
      String(
        k.measure === 'temperature'
          ? Math.round(u.tempValue(def) * 10) / 10
          : k.measure === 'gravity' && u.gravity === 'plato'
            ? Math.round(u.gravityValue(def) * 10) / 10
            : def,
      ),
    );
  };

  return (
    <Modal title={isNew ? t('New alert') : t('Edit alert')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!check.ok(t("Couldn't save"))) return;
          setBusy(true);
          try {
            await onSave(input);
            onClose();
          } catch (err) {
            toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>{t('When')}</span>
          <select className="select" value={rule.kind} onChange={(e) => changeKind(e.target.value as AlertRuleInput['kind'])}>
            {ALERT_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {t(k.label)}: {describeAfterLabel(k.describe)}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            <span>
              {t(thresholdLabel)} ({unit})
            </span>
            <input
              className="input num"
              type="number"
              step="any"
              required
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <FieldError error={errors.threshold} />
          </label>
          {rule.kind === 'gravity_stable' && (
            <label className="field">
              <span>{t('Over (hours)')}</span>
              <NumberInput
                className="input num"
                min={1}
                max={336}
                fallback={48}
                value={rule.hours}
                onValue={(hours) => setRule((r) => ({ ...r, hours }))}
              />
              <FieldError error={errors.hours} />
            </label>
          )}
          <label className="field">
            <span>{t("Don't repeat for (min)")}</span>
            <NumberInput
              className="input num"
              min={0}
              max={10080}
              fallback={0}
              value={rule.cooldownMin}
              onValue={(cooldownMin) => setRule((r) => ({ ...r, cooldownMin }))}
            />
            <FieldError error={errors.cooldownMin} />
          </label>
        </div>
        <label className="field">
          <span>{t('Name')}</span>
          <input className="input" required maxLength={80} value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} />
          <FieldError error={errors.name} />
        </label>
        <div className="field">
          <span>{t('Pills')}</span>
          <div className="chips">
            <button
              type="button"
              className={`chip${rule.pillIds === 'all' ? ' on' : ''}`}
              onClick={() => setRule({ ...rule, pillIds: 'all' })}
            >
              {t('All pills')}
            </button>
            {pills
              .filter((p) => !p.archived)
              .map((p) => {
                const ids = rule.pillIds === 'all' ? [] : rule.pillIds;
                const on = ids.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`chip${on ? ' on' : ''}`}
                    onClick={() => {
                      const next = on ? ids.filter((x) => x !== p.id) : [...ids, p.id];
                      setRule({ ...rule, pillIds: next.length ? next : 'all' });
                    }}
                  >
                    <span className="swatch" style={{ background: p.color }} /> {p.name}
                  </button>
                );
              })}
          </div>
        </div>
        <SendTo value={rule.channelIds} channels={channels} onChange={(channelIds) => setRule({ ...rule, channelIds })} />
        <FieldError error={errors.channelIds} />
        <label className="check">
          <input type="checkbox" checked={rule.onlyDuringBrew} onChange={(e) => setRule({ ...rule, onlyDuringBrew: e.target.checked })} />
          <span>
            {t('Only while a brew is running')}
            <small>{t('Ignore pills sitting idle.')}</small>
          </span>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('Save alert')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
