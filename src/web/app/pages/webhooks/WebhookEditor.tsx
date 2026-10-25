import { useEffect, useState } from 'react';
import {
  DEFAULT_WEBHOOK_OPTIONS,
  presetById,
  webhookInputSchema,
  type Webhook,
  type WebhookInput,
  type WebhookPreset,
} from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { href, navigate } from '../../router';
import { useNow } from '../../format';
import { t, tk } from '../../i18n';
import { Icon } from '../../components/Icon';
import { Switch } from '../../components/ui';
import { useFormCheck } from '../../validation';
import { PresetGrid, PresetSetup, PresetTrust } from './PresetGrid';
import { SparkleLine } from './SparkleLine';
import { RequestFields, type SetField } from './RequestFields';
import { ScheduleFields } from './ScheduleFields';
import { Preview } from './Preview';
import { DeliveryLog } from './DeliveryLog';
import { PauseButton } from './PauseButton';
import { isPausedNow, pausedText, webhookApi } from './webhookApi';
import './webhooks.css';

/** Field names for problems listed in a toast. */
const LABELS: Record<string, string> = {
  name: tk('Name'),
  url: 'URL',
  method: tk('Method'),
  bodyFormat: tk('Body'),
  timeoutSec: tk('Timeout'),
  headers: tk('Headers'),
  body: tk('Body template'),
  batchBody: tk('Batch body'),
  intervalMin: tk('Send every'),
  pillIds: tk('Pills'),
  minChangeGravity: tk('Gravity change'),
  minChangeTemp: tk('Temperature change'),
  maxSilenceMin: tk('Send at least every'),
  pausedUntil: tk('Pause'),
};

const fromPreset = (p: WebhookPreset): WebhookInput => ({
  name: p.id === 'custom' ? t('My webhook') : p.name,
  enabled: true,
  preset: p.id,
  url: p.url,
  method: p.method,
  headers: p.headers.map((h) => ({ ...h })),
  bodyFormat: p.bodyFormat,
  body: p.body,
  intervalMin: p.intervalMin,
  pillIds: 'all',
  onlyDuringBrew: false,
  onlyNewReadings: true,
  gravityUnit: p.gravityUnit,
  temperatureUnit: p.temperatureUnit,
  timeoutSec: 15,
  ...DEFAULT_WEBHOOK_OPTIONS,
});

const toInput = (h: Webhook): WebhookInput => ({
  name: h.name,
  enabled: h.enabled,
  preset: h.preset,
  url: h.url,
  method: h.method,
  headers: h.headers,
  bodyFormat: h.bodyFormat,
  body: h.body,
  intervalMin: h.intervalMin,
  pillIds: h.pillIds,
  onlyDuringBrew: h.onlyDuringBrew,
  onlyNewReadings: h.onlyNewReadings,
  gravityUnit: h.gravityUnit,
  temperatureUnit: h.temperatureUnit,
  timeoutSec: h.timeoutSec,
  skipImplausible: h.skipImplausible,
  batch: h.batch,
  batchBody: h.batchBody,
  minChangeGravity: h.minChangeGravity,
  minChangeTemp: h.minChangeTemp,
  maxSilenceMin: h.maxSilenceMin,
  pausedUntil: h.pausedUntil,
  catchUp: h.catchUp,
});

export function WebhookEditor({ id }: { id: string | null }) {
  const { isOwner, toast } = useLive();
  const [draft, setDraft] = useState<WebhookInput | null>(null);
  const [existing, setExisting] = useState<Webhook | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (id === null) {
      const presetId = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('preset');
      const preset = presetId ? presetById(presetId) : undefined;
      setDraft(preset ? fromPreset(preset) : null);
      return;
    }
    api.webhooks().then(
      (list) => {
        const hook = list.find((h) => h.id === id);
        if (!hook) return setMissing(true);
        setExisting(hook);
        setDraft(toInput(hook));
      },
      (err) => toast({ tone: 'error', title: t("Couldn't load the webhook"), body: errorText(err) }),
    );
  }, [id, toast]);

  if (!isOwner) {
    return (
      <div className="panel empty">
        <h2>{t('Owner only')}</h2>
        <p>{t('Webhooks can hold API keys, so only the owner can see and edit them.')}</p>
        <a className="btn primary" href="#/settings">
          <Icon name="lock" /> {t('Sign in')}
        </a>
      </div>
    );
  }
  if (missing) {
    return (
      <div className="panel empty">
        <h2>{t('Webhook not found')}</h2>
        <a className="btn" href="#/webhooks">
          {t('All webhooks')}
        </a>
      </div>
    );
  }

  if (id === null && draft === null) {
    return (
      <div className="page">
        <div>
          <a className="back" href="#/webhooks">
            <Icon name="left" size={16} /> {t('Webhooks')}
          </a>
          <div className="page-head">
            <div>
              <h1>{t('New webhook')}</h1>
              <SparkleLine />
              <p style={{ marginTop: '0.6rem' }}>{t('Choose where your readings should go. Everything can be changed afterwards.')}</p>
            </div>
          </div>
        </div>
        <PresetGrid onPick={(p) => setDraft(fromPreset(p))} />
      </div>
    );
  }
  if (!draft) return <div className="skeleton" style={{ height: '24rem' }} />;
  return <EditorForm draft={draft} setDraft={setDraft} existing={existing} setExisting={setExisting} />;
}

function EditorForm({
  draft,
  setDraft,
  existing,
  setExisting,
}: {
  draft: WebhookInput;
  setDraft: React.Dispatch<React.SetStateAction<WebhookInput | null>>;
  existing: Webhook | null;
  setExisting: (hook: Webhook) => void;
}) {
  const { toast } = useLive();
  const now = useNow(30_000);
  const preset = presetById(draft.preset);
  const [saving, setSaving] = useState(false);
  const set: SetField = (k, v) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const check = useFormCheck(webhookInputSchema, draft, LABELS);
  const paused = isPausedNow(draft, now);

  const save = async () => {
    if (!check.ok(t("Couldn't save"))) return;
    setSaving(true);
    try {
      const saved = existing ? await api.updateWebhook(existing.id, draft) : await api.createWebhook(draft);
      toast({
        tone: 'success',
        title: existing ? t('Webhook saved') : t('Webhook created'),
        body: draft.enabled ? t('It sends on its schedule from now on.') : t('It is switched off.'),
      });
      if (!existing) navigate(href.webhook(saved.id));
      else navigate('#/webhooks');
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
    } finally {
      setSaving(false);
    }
  };

  // Pausing takes effect straight away, without saving the other changes.
  const onPaused = (hook: Webhook) => {
    setExisting(hook);
    setDraft((d) => (d ? { ...d, pausedUntil: hook.pausedUntil } : d));
  };

  const duplicate = async () => {
    if (!existing) return;
    try {
      const copy = await webhookApi.duplicate(existing.id);
      toast({
        tone: 'success',
        title: t('Made "{name}"', { name: copy.name }),
        body: t('A switched-off copy of the saved webhook. You are editing the copy now.'),
      });
      navigate(href.webhook(copy.id));
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't duplicate"), body: errorText(err) });
    }
  };

  return (
    <div className="page">
      <div>
        <a className="back" href="#/webhooks">
          <Icon name="left" size={16} /> {t('Webhooks')}
        </a>
        <div className="page-head">
          <div className="row">
            <span className="badge" style={{ fontSize: '2rem' }}>
              {preset?.badge ?? '🪝'}
            </span>
            <div>
              <h1>{existing ? t('Edit webhook') : preset ? t('New {name} webhook', { name: preset.name }) : t('New webhook')}</h1>
              <p>
                {preset && t(preset.tagline)} {preset && <PresetTrust preset={preset} />}
              </p>
            </div>
          </div>
          <div className="row">
            {existing && (
              <>
                <PauseButton hook={{ ...existing, pausedUntil: draft.pausedUntil }} onChange={onPaused} />
                <button type="button" className="btn small ghost" onClick={() => void duplicate()}>
                  <Icon name="copy" size={14} /> {t('Duplicate')}
                </button>
              </>
            )}
            <span className="small muted">{t('Enabled')}</span>
            <Switch on={draft.enabled} onChange={(on) => set('enabled', on)} label={t('Enabled')} />
          </div>
        </div>
      </div>

      {paused && draft.pausedUntil !== null && (
        <div className="notice warning wh-notice">
          <Icon name="pause" />
          <p className="grow">
            {pausedText(draft.pausedUntil, now)}. {t('Nothing is sent until then; your pills are still recorded.')}
          </p>
        </div>
      )}

      <div className="editor">
        <div className="stack">
          <RequestFields draft={draft} set={set} errors={check.errors} />
          <ScheduleFields draft={draft} set={set} errors={check.errors} />

          <div className="row">
            <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
              <Icon name="check" /> {existing ? t('Save changes') : t('Create webhook')}
            </button>
            <a className="btn ghost" href="#/webhooks">
              {t('Cancel')}
            </a>
          </div>

          {existing && <DeliveryLog webhookId={existing.id} />}
        </div>

        <div className="sticky stack">
          <Preview draft={draft} webhookId={existing?.id ?? null} canSend={() => check.ok(t("Couldn't send the test"))} />
          {preset && <PresetSetup preset={preset} />}
        </div>
      </div>
    </div>
  );
}
