import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { mixesPills, presetById, type Webhook } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { href, navigate } from '../../router';
import { timeAgo, timeUntil, useNow } from '../../format';
import { t, tp } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { Icon } from '../../components/Icon';
import { Confirm, Switch } from '../../components/ui';
import { PresetGrid } from './PresetGrid';
import { SparkleLine } from './SparkleLine';
import { PauseButton } from './PauseButton';
import { isPausedNow, pausedText, webhookApi } from './webhookApi';
import './webhooks.css';

function useWebhooks() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const { toast, isOwner } = useLive();
  const load = useCallback(async () => {
    try {
      setHooks(await api.webhooks());
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't load webhooks"), body: errorText(err) });
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load, isOwner]);
  useLiveMessages((msg) => {
    if (msg.type === 'webhook') setHooks((cur) => cur?.map((h) => (h.id === msg.webhookId ? { ...h, status: msg.status } : h)) ?? cur);
  });
  return { hooks, setHooks, reload: load };
}

const every = (min: number) => (min >= 60 && min % 60 === 0 ? t('{count} h', { count: min / 60 }) : t('{count} min', { count: min }));

/** Import from / export to a JSON file. */
function ImportExport({ onImported }: { onImported: (hooks: Webhook[]) => void }) {
  const { toast } = useLive();
  const file = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);

  const importFile = async (f: File) => {
    try {
      let data: unknown;
      try {
        data = JSON.parse(await f.text());
      } catch {
        throw new Error(t("That file isn't a RaptHooker webhooks export (it isn't JSON)."));
      }
      const created = await webhookApi.import(data);
      onImported(created);
      toast({
        tone: 'success',
        title: tp(created.length, 'Imported {count} webhook', 'Imported {count} webhooks'),
        body: t('They are switched off: check each one, then switch it on.'),
      });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't import"), body: errorText(err) });
    }
  };

  return (
    <>
      <button type="button" className="btn" onClick={() => file.current?.click()}>
        <Icon name="upload" size={16} /> {t('Import')}
      </button>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />
      <button type="button" className="btn" onClick={() => setExporting(true)}>
        <Icon name="download" size={16} /> {t('Export')}
      </button>
      {exporting &&
        createPortal(
          <Confirm
            title={t('Export all webhooks?')}
            body={
              <>
                <p>
                  <Trans
                    text={t('The file has everything needed to set them up on another hub, {secrets} in URLs, headers and bodies.')}
                    values={{ secrets: <strong>{t('including API keys and tokens')}</strong> }}
                  />{' '}
                  {t('Keep it somewhere private.')}
                </p>
                <p className="small">{t('Imported webhooks start switched off.')}</p>
              </>
            }
            confirm={t('Download')}
            onClose={() => setExporting(false)}
            onConfirm={() => {
              const a = document.createElement('a');
              a.href = webhookApi.exportUrl;
              a.download = '';
              document.body.append(a);
              a.click();
              a.remove();
            }}
          />,
          document.body,
        )}
    </>
  );
}

export function WebhooksPage() {
  const { hooks, setHooks } = useWebhooks();
  const { isOwner, pills, toast } = useLive();
  const now = useNow(15_000);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const pillName = (id: string) => pills.find((p) => p.id === id)?.name ?? t('removed pill');
  const replace = (updated: Webhook) => setHooks((cur) => cur?.map((h) => (h.id === updated.id ? updated : h)) ?? cur);

  const toggle = async (hook: Webhook, enabled: boolean) => {
    try {
      replace(await api.setWebhookEnabled(hook.id, enabled));
    } catch (err) {
      toast({ tone: 'error', title: enabled ? t("Couldn't switch on") : t("Couldn't switch off"), body: errorText(err) });
    }
  };

  const duplicate = async (hook: Webhook) => {
    try {
      const copy = await webhookApi.duplicate(hook.id);
      setHooks((cur) => (cur ? [...cur, copy] : cur));
      toast({
        tone: 'success',
        title: t('Made "{name}"', { name: copy.name }),
        body: t("It's switched off until you've changed what you need."),
      });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't duplicate"), body: errorText(err) });
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Webhooks')}</h1>
          <SparkleLine />
          <p style={{ marginTop: '0.6rem' }}>
            {t("Send your pills' readings to Brewfather, Grainfather, Brewer's Friend, Home Assistant or anything with a URL.")}
          </p>
        </div>
        {isOwner && (
          <div className="page-actions">
            <ImportExport onImported={(created) => setHooks((cur) => [...(cur ?? []), ...created])} />
            <a className="btn primary" href={href.webhook(null)}>
              <Icon name="plus" /> {t('New webhook')}
            </a>
          </div>
        )}
      </div>

      {hooks === null ? (
        <div className="skeleton" style={{ height: '10rem' }} />
      ) : hooks.length === 0 ? (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>
                <Icon name="sparkles" /> {t('Start with a preset')}
              </h2>
              <p>{t('Pick a service: the URL, payload and timing are filled in for you.')}</p>
            </div>
          </div>
          <PresetGrid onPick={(p) => (isOwner ? navigate(`#/webhooks/new?preset=${p.id}`) : navigate('#/settings'))} />
          {!isOwner && <p className="hint">{t('Sign in with the owner PIN to create webhooks.')}</p>}
        </div>
      ) : (
        <div className="stack">
          {hooks.map((h) => {
            const preset = presetById(h.preset);
            const st = h.status;
            const paused = isPausedNow(h, now);
            const next = st.pills
              .map((p) => p.nextAt)
              .filter((n): n is number => n !== null)
              .sort()[0];
            const notes = st.pills.filter((p) => p.skipped);
            return (
              <article key={h.id} className={`panel hook-card${h.enabled && !paused ? '' : ' disabled'}${paused ? ' paused' : ''}`}>
                <div className="badge">{preset?.badge ?? '🪝'}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: '0.5rem' }}>
                    <h3>{h.name}</h3>
                    {paused && h.pausedUntil !== null && (
                      <span className="chip warning">
                        <Icon name="pause" size={12} /> {pausedText(h.pausedUntil, now)}
                      </span>
                    )}
                    {st.lastOk === true && <span className="chip success">{t('Working')}</span>}
                    {st.lastOk === false && <span className="chip danger">{t('Failing')}</span>}
                    {st.lastOk === null && <span className="chip">{t('Not sent yet')}</span>}
                  </div>
                  <div className="url">
                    <span className="method">{h.method}</span> {h.url}
                  </div>
                  <div className="chips" style={{ marginTop: '0.45rem' }}>
                    <span className="chip">
                      <Icon name="clock" size={12} /> {t('every {interval}', { interval: every(h.intervalMin) })}
                    </span>
                    <span className="chip">
                      <Icon name="droplet" size={12} />{' '}
                      {h.pillIds === 'all' ? t('All pills') : h.pillIds.map(pillName).join(', ') || t('No pills')}
                    </span>
                    {mixesPills(preset, h.pillIds) && (
                      <span
                        className="chip warning"
                        title={t('Readings from more than one pill will be mixed together in {name}.', { name: preset!.name })}
                      >
                        <Icon name="alert" size={12} /> {t('Several pills on one {name} device', { name: preset!.name })}
                      </span>
                    )}
                    {h.batch && <span className="chip">{t('One request for all')}</span>}
                    {h.onlyDuringBrew && <span className="chip">{t('While brewing')}</span>}
                    {(h.minChangeGravity !== null || h.minChangeTemp !== null) && <span className="chip">{t('On change')}</span>}
                    {h.catchUp && <span className="chip">{t('Catches up')}</span>}
                    <span className="chip">
                      {h.gravityUnit === 'plato' ? '°P' : 'SG'} · °{h.temperatureUnit}
                    </span>
                  </div>
                  <p className="small muted" style={{ margin: '0.45rem 0 0' }}>
                    {st.lastAt
                      ? st.lastHttpStatus
                        ? t('Last sent {ago} (HTTP {status})', { ago: timeAgo(st.lastAt, now), status: st.lastHttpStatus })
                        : t('Last sent {ago}', { ago: timeAgo(st.lastAt, now) })
                      : t('Waiting for a reading')}
                    {st.lastOk === false && st.lastError ? `: ${st.lastError}` : ''}
                    {h.enabled && !paused && next ? ` · ${t('next {when}', { when: timeUntil(next, now) })}` : ''} ·{' '}
                    {tp(st.sent24h, '{count} sent in 24 h', '{count} sent in 24 h')}
                    {st.failed24h ? `, ${tp(st.failed24h, '{count} failed', '{count} failed')}` : ''}
                  </p>
                  {h.enabled && !paused && notes.length > 0 && (
                    <ul className="hook-notes">
                      {notes.map((p) => (
                        <li key={p.pillId}>
                          {pillName(p.pillId)}: {p.skipped}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="row actions" style={{ justifyContent: 'flex-end' }}>
                  <Switch
                    on={h.enabled}
                    onChange={(on) => void toggle(h, on)}
                    disabled={!isOwner}
                    label={h.enabled ? t('Switch off') : t('Switch on')}
                  />
                  {isOwner && (
                    <>
                      {(h.enabled || paused) && <PauseButton hook={h} onChange={replace} />}
                      <a className="btn small" href={href.webhook(h.id)}>
                        <Icon name="pencil" size={14} /> {t('Edit')}
                      </a>
                      <button
                        type="button"
                        className="btn small icon ghost"
                        aria-label={t('Duplicate')}
                        title={t('Duplicate')}
                        onClick={() => void duplicate(h)}
                      >
                        <Icon name="copy" size={16} />
                      </button>
                      <button
                        type="button"
                        className="btn small icon ghost"
                        aria-label={t('Delete')}
                        title={t('Delete')}
                        onClick={() => setDeleting(h)}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {deleting && (
        <Confirm
          title={t('Delete "{name}"?', { name: deleting.name })}
          body={<p>{t('It stops sending straight away and its delivery log is deleted.')}</p>}
          confirm={t('Delete')}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteWebhook(deleting.id);
              setHooks((cur) => cur?.filter((h) => h.id !== deleting.id) ?? cur);
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't delete"), body: errorText(err) });
            }
          }}
        />
      )}
    </div>
  );
}
