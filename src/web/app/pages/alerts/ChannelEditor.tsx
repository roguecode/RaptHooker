import { useState, type ChangeEvent, type ReactNode } from 'react';
import {
  CHANNEL_KINDS,
  channelFieldProblems,
  channelKindInfo,
  type Channel,
  type ChannelField,
  type ChannelInput,
  type ChannelKind,
} from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { Icon } from '../../components/Icon';
import { Modal, Switch } from '../../components/ui';
import { FieldError } from '../../validation';
import { t } from '../../i18n';
import { ChannelIcon } from './ChannelIcon';
import { channelApi, toChannelInput } from './channelApi';
import { channelKindLabel, channelProblemText } from './strings';

const fresh = (kind: ChannelKind): ChannelInput => {
  const info = channelKindInfo(kind);
  return {
    name: channelKindLabel(kind),
    kind,
    enabled: true,
    config: Object.fromEntries(info.fields.map((f) => [f.key, f.default ?? ''])),
  };
};

/** A topic nobody will guess, like rapthooker-k7p2x9q4. */
function randomTopic(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `rapthooker-${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
}

function KindPicker({ onPick }: { onPick: (kind: ChannelKind) => void }) {
  return (
    <div className="presets">
      {CHANNEL_KINDS.map((k) => (
        <button key={k.kind} type="button" className="preset" onClick={() => onPick(k.kind)}>
          <span className="badge">
            <ChannelIcon kind={k.kind} size={22} />
          </span>
          <span>
            <strong>{channelKindLabel(k.kind)}</strong>
            <span>{t(k.tagline)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  error,
}: {
  field: ChannelField;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const [show, setShow] = useState(false);
  const id = `channel-${field.key}`;
  const common = {
    id,
    className: 'input',
    value,
    placeholder: field.placeholder && t(field.placeholder),
    'aria-invalid': error ? true : undefined,
    onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
  };
  let input: ReactNode;
  if (field.input === 'select') {
    input = (
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.label)}
          </option>
        ))}
      </select>
    );
  } else if (field.input === 'password') {
    input = (
      <div className="channel-secret">
        <input {...common} type={show ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} />
        <button type="button" className="btn small ghost" onClick={() => setShow((s) => !s)} aria-pressed={show}>
          {show ? t('Hide') : t('Show')}
        </button>
      </div>
    );
  } else {
    input = (
      <input
        {...common}
        type={field.input === 'number' ? 'number' : field.input === 'url' ? 'url' : 'text'}
        inputMode={field.input === 'number' ? 'numeric' : undefined}
        autoComplete="off"
        spellCheck={false}
      />
    );
  }
  return (
    <div className="field">
      <span>
        <label htmlFor={id}>{t(field.label)}</label>
        {!field.required && !field.default && <span className="faint"> {t('(optional)')}</span>}
      </span>
      {input}
      {field.help && <span className="hint">{t(field.help)}</span>}
      <FieldError error={error} />
      {field.key === 'topic' && !value && (
        <button type="button" className="btn small ghost channel-make-topic" onClick={() => onChange(randomTopic())}>
          <Icon name="sparkles" size={14} /> {t('Make one up')}
        </button>
      )}
    </div>
  );
}

/** Adds or edits a channel: pick the service, fill in its settings, send a test. */
export function ChannelEditor({ channel, onClose, onSaved }: { channel: Channel | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useLive();
  const [draft, setDraft] = useState<ChannelInput | null>(channel ? toChannelInput(channel) : null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  if (!draft) {
    return (
      <Modal title={t('Where should alerts go?')} wide onClose={onClose}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('Pick a service. You can add as many as you like and choose which alerts use each one.')}
        </p>
        <KindPicker
          onPick={(kind) => {
            setTried(false);
            setDraft(fresh(kind));
          }}
        />
      </Modal>
    );
  }

  const info = channelKindInfo(draft.kind);
  const label = channelKindLabel(draft.kind);
  const problems = Object.fromEntries(Object.entries(channelFieldProblems(draft)).map(([k, m]) => [k, channelProblemText(info, k, m)]));
  const nameError = draft.name.trim() ? undefined : t('Give it a name');
  const errors: Record<string, string | undefined> = tried ? { ...problems, name: nameError } : {};
  const setConfig = (key: string, value: string) => setDraft((d) => (d ? { ...d, config: { ...d.config, [key]: value } } : d));

  /** True when everything needed is filled in; otherwise says what's missing. */
  const ready = (title: string, settingsNeeded: boolean): boolean => {
    setTried(true);
    const list = [nameError, ...(settingsNeeded ? Object.values(problems) : [])].filter(Boolean);
    if (list.length === 0) return true;
    toast({ tone: 'error', title, body: `${list.join('. ')}.` });
    return false;
  };

  const save = async () => {
    if (!ready(t("Couldn't save"), draft.enabled)) return;
    setBusy('save');
    try {
      if (channel) await channelApi.update(channel.id, draft);
      else await channelApi.create(draft);
      toast({
        tone: 'success',
        title: channel ? t('Saved') : t('{service} added', { service: label }),
        body: draft.enabled ? undefined : t("It's switched off for now."),
      });
      onSaved();
      onClose();
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!ready(t("Couldn't send a test"), true)) return;
    setBusy('test');
    try {
      await channelApi.test(draft, channel?.id ?? null);
      toast({ tone: 'success', title: t('Test sent'), body: t('Check {service} for a message from RaptHooker.', { service: label }) });
    } catch (err) {
      toast({ tone: 'error', title: t('Test failed'), body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      wide
      onClose={onClose}
      title={
        <span className="row">
          <ChannelIcon kind={draft.kind} size={22} />{' '}
          {channel ? t('Edit {name}', { name: channel.name }) : t('Add {service}', { service: label })}
        </span>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="channel-editor">
          <div className="stack">
            <div className="row channel-name-row">
              <label className="field grow">
                <span>{t('Name')}</span>
                <input
                  className="input"
                  required
                  maxLength={80}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <FieldError error={errors.name} />
              </label>
              <span className="row small muted">
                {/* i18n: next to a switch: the service is switched on */}
                {t('On')} <Switch on={draft.enabled} onChange={(on) => setDraft({ ...draft, enabled: on })} label={t('Switched on')} />
              </span>
            </div>
            <div className="form-grid">
              {info.fields.map((f) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={draft.config[f.key] ?? ''}
                  onChange={(v) => setConfig(f.key, v)}
                  error={errors[f.key]}
                />
              ))}
            </div>
          </div>
          <aside className="channel-help">
            <h3>{t('Setting up {service}', { service: label })}</h3>
            <ol className="steps">
              {info.steps.map((s) => (
                <li key={s}>{t(s)}</li>
              ))}
            </ol>
            <div className="stack channel-links">
              {info.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
                  {t(l.label)} <Icon name="external" size={12} />
                </a>
              ))}
            </div>
          </aside>
        </div>
        <div className="modal-actions">
          {!channel && (
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
              <Icon name="left" size={16} /> {t('Other services')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void test()}>
            <Icon name="send" size={16} /> {busy === 'test' ? t('Sending…') : t('Send test')}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy !== null}>
            <Icon name="check" size={16} /> {channel ? t('Save') : t('Add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
