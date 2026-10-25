import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { tokenInputSchema, type ApiToken, type ApiTokenCreated, type TokenScope } from '@rapthooker/shared';
import { errorText, http } from '../../api';
import { useLive } from '../../live';
import { dateOnly, timeAgo, useNow } from '../../format';
import { t, tk } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { Icon } from '../../components/Icon';
import { Confirm, Modal, OwnerOnly } from '../../components/ui';
import { FieldError, useFormCheck } from '../../validation';
import './TokensSection.css';

const DOCS = 'https://github.com/roguecode/RaptHooker/blob/main/docs';

const SCOPES: { scope: TokenScope; label: string; hint: string }[] = [
  { scope: 'read', label: tk('Read'), hint: tk('For scripts and dashboards: can read pills, readings and brews, but change nothing.') },
  {
    scope: 'relay',
    label: tk('Relay'),
    hint: tk('For a Bluetooth relay (e.g. an ESP32) that passes on what it hears; it can read nothing.'),
  },
];

const tokensApi = {
  list: () => http.get<ApiToken[]>('/api/tokens'),
  create: (name: string, scope: TokenScope) => http.post<ApiTokenCreated>('/api/tokens', { name, scope }),
  remove: (id: string) => http.del(`/api/tokens/${encodeURIComponent(id)}`),
};

/** API tokens for scripts (read-only API) and Bluetooth relays. */
export function TokensSection() {
  const { isOwner, toast } = useLive();
  const now = useNow(60_000);
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('read');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [deleting, setDeleting] = useState<ApiToken | null>(null);
  const check = useFormCheck(tokenInputSchema, { name, scope }, { name: tk('Name') });
  // The name box is emptied after a token is made; that's not a mistake to point out.
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(() => {
    if (!isOwner) return;
    tokensApi.list().then(setTokens, (err) => toast({ tone: 'error', title: t("Couldn't load API tokens"), body: errorText(err) }));
  }, [isOwner, toast]);
  useEffect(load, [load]);

  const create = async () => {
    if (!check.ok(t("Couldn't create the token"))) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setBusy(true);
    try {
      const token = await tokensApi.create(name.trim(), scope);
      setCreated(token);
      setName('');
      load();
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't create the token"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="key" /> {t('API tokens')}
          </h2>
          <p>
            {t('Keys for your own scripts and for Bluetooth relays.')}{' '}
            <Trans
              text={t('See the {api} and the {relay}.')}
              values={{
                api: (
                  <a href={`${DOCS}/api.md`} target="_blank" rel="noreferrer">
                    {t('API guide')}
                  </a>
                ),
                relay: (
                  <a href={`${DOCS}/relay.md`} target="_blank" rel="noreferrer">
                    {t('relay guide')}
                  </a>
                ),
              }}
            />
          </p>
        </div>
      </div>

      {!isOwner ? (
        <OwnerOnly isOwner={false}>{null}</OwnerOnly>
      ) : (
        <div className="stack">
          <form
            className="token-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="field">
              <span>{t('Name')}</span>
              <input
                className="input"
                placeholder={t('e.g. Grafana, Garage relay')}
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
              <FieldError error={showErrors ? check.errors.name : undefined} />
            </label>
            <div className="field">
              <span>{t('Can')}</span>
              <div className="segmented">
                {SCOPES.map((s) => (
                  <button key={s.scope} type="button" className={scope === s.scope ? 'on' : ''} onClick={() => setScope(s.scope)}>
                    {t(s.label)}
                  </button>
                ))}
              </div>
            </div>
            <button type="submit" className="btn primary" disabled={busy}>
              <Icon name="plus" size={16} /> {t('Create token')}
            </button>
          </form>
          <p className="hint" style={{ margin: 0 }}>
            {t(SCOPES.find((s) => s.scope === scope)!.hint)}
          </p>

          {tokens && tokens.length > 0 && (
            <div className="list">
              {tokens.map((tok) => (
                <div key={tok.id} className="list-item">
                  <Icon name="key" />
                  <div className="grow">
                    <h4>
                      {tok.name}{' '}
                      <span className={`chip${tok.scope === 'relay' ? ' brew' : ''}`}>{tok.scope === 'read' ? t('Read') : t('Relay')}</span>
                    </h4>
                    <p>
                      <code>
                        rh_{tok.scope}_…{tok.hint}
                      </code>{' '}
                      · {t('created {date}', { date: dateOnly(tok.createdAt) })} ·{' '}
                      {tok.lastUsedAt ? t('last used {ago}', { ago: timeAgo(tok.lastUsedAt, now) }) : t('never used')}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn small icon ghost"
                    aria-label={t('Delete {name}', { name: tok.name })}
                    title={t('Delete')}
                    onClick={() => setDeleting(tok)}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {tokens && tokens.length === 0 && (
            <p className="muted small" style={{ margin: 0 }}>
              {t('No tokens yet.')}
            </p>
          )}
        </div>
      )}

      {created && createPortal(<CreatedToken token={created} onClose={() => setCreated(null)} />, document.body)}
      {deleting &&
        createPortal(
          <Confirm
            title={t('Delete "{name}"?', { name: deleting.name })}
            body={<p>{t('Anything using this token stops working straight away.')}</p>}
            confirm={t('Delete')}
            danger
            onClose={() => setDeleting(null)}
            onConfirm={async () => {
              try {
                await tokensApi.remove(deleting.id);
                setTokens((cur) => cur?.filter((tok) => tok.id !== deleting.id) ?? cur);
              } catch (err) {
                toast({ tone: 'error', title: t("Couldn't delete"), body: errorText(err) });
              }
            }}
          />,
          document.body,
        )}
    </section>
  );
}

/** Shown once, straight after creating a token: the hub only keeps a hash of it. */
function CreatedToken({ token, onClose }: { token: ApiTokenCreated; onClose: () => void }) {
  const { toast } = useLive();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
    } catch {
      toast({ tone: 'warning', title: t("Couldn't copy"), body: t('Select the token and copy it yourself.') });
    }
  };
  const example =
    token.scope === 'read'
      ? `curl -H "Authorization: Bearer ${token.token}" ${window.location.origin}/api/pills`
      : t('See the relay guide for setting up an ESP32 with this token.');

  return (
    <Modal title={t('Your new token "{name}"', { name: token.name })} onClose={onClose}>
      <div className="stack">
        <div className="notice warning">
          <Icon name="alert" />
          <p className="grow">
            {t("Copy it now: it won't be shown again.")}{' '}
            {token.scope === 'read' ? t('Anyone with it can read your data.') : t('Anyone with it can send readings to this hub.')}
          </p>
        </div>
        <div className="code-block token-value">{token.token}</div>
        <div className="small muted">{t('Example')}</div>
        <div className="code-block">{example}</div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => void copy()}>
            <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? t('Copied') : t('Copy token')}
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            {t('Done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
