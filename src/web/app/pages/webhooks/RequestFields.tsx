import { Fragment, useRef } from 'react';
import { BATCH_FORMATS, BATCH_VARIABLES, VARIABLES, type FieldErrors, type WebhookInput } from '@rapthooker/shared';
import { t } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { Icon } from '../../components/Icon';
import { NumberInput } from '../../components/NumberInput';
import { FieldError } from '../../validation';

export type SetField = <K extends keyof WebhookInput>(k: K, v: WebhookInput[K]) => void;

export interface FieldsProps {
  draft: WebhookInput;
  set: SetField;
  errors: FieldErrors;
}

type TemplateField = 'url' | 'body' | 'batchBody';

const DEFAULT_BATCH_BODY: Record<string, string> = {
  json: '{\n  "hub": "{{hub_name}}",\n  "readings": [{{items}}]\n}',
  text: '{{items}}',
};

/** Where the webhook goes and what it sends. */
export function RequestFields({ draft, set, errors }: FieldsProps) {
  const lastField = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; key: TemplateField } | null>(null);
  const insert = (key: string) => {
    const target = lastField.current;
    const token = `{{${key}}}`;
    if (!target) {
      set('body', draft.body + token);
      return;
    }
    const { el } = target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const value = el.value.slice(0, start) + token + el.value.slice(end);
    set(target.key, value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const groups = ['Pill', 'Reading', 'Brew', 'Time', 'Other'] as const;
  const hasBody = draft.method !== 'GET' && draft.bodyFormat !== 'none';
  const canBatch = draft.method !== 'GET' && BATCH_FORMATS.includes(draft.bodyFormat);

  return (
    <section className="panel stack">
      <label className="field">
        <span>{t('Name')}</span>
        <input className="input" value={draft.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />
        <FieldError error={errors.name} />
      </label>
      <label className="field">
        <span>URL</span>
        <input
          className="input"
          style={{ fontFamily: 'var(--mono)', fontSize: '0.88rem' }}
          value={draft.url}
          spellCheck={false}
          onFocus={(e) => (lastField.current = { el: e.currentTarget, key: 'url' })}
          onChange={(e) => set('url', e.target.value)}
        />
        <FieldError error={errors.url} />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>{t('Method')}</span>
          <select className="select" value={draft.method} onChange={(e) => set('method', e.target.value as WebhookInput['method'])}>
            {['POST', 'PUT', 'PATCH', 'GET'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('Body')}</span>
          <select
            className="select"
            value={draft.bodyFormat}
            disabled={draft.method === 'GET'}
            onChange={(e) => set('bodyFormat', e.target.value as WebhookInput['bodyFormat'])}
          >
            <option value="json">JSON</option>
            <option value="form">{t('Form (urlencoded)')}</option>
            <option value="text">{t('Plain text')}</option>
            <option value="none">{t('No body')}</option>
          </select>
        </label>
        <label className="field">
          <span>{t('Timeout (s)')}</span>
          <NumberInput
            className="input num"
            min={1}
            max={60}
            fallback={15}
            value={draft.timeoutSec}
            onValue={(v) => set('timeoutSec', v)}
          />
          <FieldError error={errors.timeoutSec} />
        </label>
      </div>

      <div className="field">
        <span>{t('Headers')}</span>
        <div className="stack" style={{ gap: '0.4rem' }}>
          {draft.headers.map((h, i) => (
            <Fragment key={i}>
              <div className="header-row">
                <input
                  className="input"
                  placeholder={t('Header')}
                  value={h.name}
                  onChange={(e) =>
                    set(
                      'headers',
                      draft.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <input
                  className="input"
                  placeholder={t('Value')}
                  value={h.value}
                  style={{ fontFamily: 'var(--mono)', fontSize: '0.85rem' }}
                  onChange={(e) =>
                    set(
                      'headers',
                      draft.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                    )
                  }
                />
                <button
                  type="button"
                  className="btn icon small ghost"
                  aria-label={t('Remove header')}
                  onClick={() =>
                    set(
                      'headers',
                      draft.headers.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
              <FieldError error={errors[`headers.${i}.name`] ?? errors[`headers.${i}.value`]} />
            </Fragment>
          ))}
          <div>
            <button type="button" className="btn small" onClick={() => set('headers', [...draft.headers, { name: '', value: '' }])}>
              <Icon name="plus" size={14} /> {t('Add header')}
            </button>
          </div>
        </div>
        <FieldError error={errors.headers} />
      </div>

      {hasBody && (
        <label className="field">
          <span>{draft.batch ? t('Body template (for each pill)') : t('Body template')}</span>
          <textarea
            className="textarea code"
            spellCheck={false}
            value={draft.body}
            onFocus={(e) => (lastField.current = { el: e.currentTarget, key: 'body' })}
            onChange={(e) => set('body', e.target.value)}
          />
          <FieldError error={errors.body} />
        </label>
      )}
      {(canBatch || draft.batch) && (
        <div className="option-group">
          <label className="check">
            <input
              type="checkbox"
              checked={draft.batch}
              onChange={(e) => {
                set('batch', e.target.checked);
                if (e.target.checked && !draft.batchBody.trim()) set('batchBody', DEFAULT_BATCH_BODY[draft.bodyFormat] ?? '{{items}}');
              }}
            />
            <span>
              {t('Send all pills in one request')}
              <small>
                <Trans
                  text={t(
                    'The body template above is filled in for each pill, and the results go where {items} is below (separated by commas in JSON, by new lines in plain text). Only for JSON and plain-text bodies.',
                  )}
                  values={{ items: <code>{'{{items}}'}</code> }}
                />
              </small>
            </span>
          </label>
          {draft.batch && (
            <div className="field">
              <span>{t('Batch body')}</span>
              <textarea
                className="textarea code batch"
                spellCheck={false}
                value={draft.batchBody}
                onFocus={(e) => (lastField.current = { el: e.currentTarget, key: 'batchBody' })}
                onChange={(e) => set('batchBody', e.target.value)}
              />
              <FieldError error={errors.batchBody} />
              <div className="var-chips">
                {BATCH_VARIABLES.map((v) => (
                  <button key={v.key} type="button" title={t(v.description)} onClick={() => insert(v.key)}>
                    {v.key}
                  </button>
                ))}
              </div>
              <span className="hint">
                {t('Pill and reading variables only work in the per-pill body template; the URL, headers and batch body get these.')}
              </span>
            </div>
          )}
          {draft.batch && !canBatch && (
            <span className="field-error">{t('Sending all pills in one request needs a JSON or plain-text body (and not GET).')}</span>
          )}
        </div>
      )}
      <div className="field">
        <span>{t('Variables: click to insert')}</span>
        <div className="var-chips">
          {groups.map((g) =>
            VARIABLES.filter((v) => v.group === g).map((v) => (
              <button key={v.key} type="button" title={`${t(g)}: ${t(v.description)}`} onClick={() => insert(v.key)}>
                {v.key}
              </button>
            )),
          )}
        </div>
        <span className="hint">
          <Trans
            text={t('Write {text} for text and {number} for numbers.')}
            values={{ text: <code>"{'{{name}}'}"</code>, number: <code>{'{{gravity}}'}</code> }}
          />{' '}
          <Trans
            text={t('Empty values become {null} in JSON; give a fallback with {fallback}.')}
            values={{ null: <code>null</code>, fallback: <code>{'{{velocity|0}}'}</code> }}
          />
        </span>
      </div>
    </section>
  );
}
