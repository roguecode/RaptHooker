import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_MQTT_SETTINGS, mqttSettingsSchema, type MqttSettings, type MqttStatus } from '@rapthooker/shared';
import { errorText, http } from '../../api';
import { useLive } from '../../live';
import { timeAgo, useNow } from '../../format';
import { t, tk } from '../../i18n';
import { Trans } from '../../i18n/Trans';
import { Icon } from '../../components/Icon';
import { OwnerOnly, Switch } from '../../components/ui';
import { FieldError, useFormCheck } from '../../validation';
import './MqttSection.css';

/** Field names for problems listed in a toast. */
const LABELS: Record<string, string> = {
  url: tk('Broker address'),
  username: tk('Username'),
  password: tk('Password'),
  topic: tk('Base topic'),
  discoveryPrefix: tk('Discovery prefix'),
};

const CHIPS: Record<MqttStatus['state'], { className: string; text: string }> = {
  off: { className: 'chip', text: tk('Off') },
  connecting: { className: 'chip warning', text: tk('Connecting…') },
  connected: { className: 'chip success', text: tk('Connected') },
  error: { className: 'chip danger', text: tk('Not connected') },
};

const DOCS_URL = 'https://github.com/roguecode/RaptHooker/blob/main/docs/home-assistant.md';

/** The fields of each reading's JSON, shown as code in "What gets published". */
const STATE_FIELDS = [
  'gravity',
  'gravity_plato',
  'temperature',
  'velocity',
  'battery',
  'rssi',
  'tilt',
  'plausible',
  'timestamp',
  'brew_name',
  'og',
  'abv',
  'attenuation',
  'stage',
];
const STATE_CODES = Object.fromEntries(STATE_FIELDS.map((f) => [f, <code key={f}>{f}</code>]));

interface TestResult {
  ok: boolean;
  error: string | null;
}

/** Checks the API makes on top of the schema. */
function extraErrors(d: MqttSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  if (d.enabled && !d.url.trim()) errors.url = t('Enter the broker address, or switch MQTT off');
  if (d.password && !d.username.trim()) errors.username = t('MQTT only sends a password along with a username');
  return errors;
}

/** Publishing readings to an MQTT broker, and Home Assistant discovery. Only the owner can see and change the settings. */
export function MqttSection() {
  const { isOwner, toast, pills } = useLive();
  const [status, setStatus] = useState<MqttStatus | null>(null);
  const [draft, setDraft] = useState<MqttSettings | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [tried, setTried] = useState(false);
  const now = useNow(10_000);
  const check = useFormCheck(mqttSettingsSchema, draft ?? DEFAULT_MQTT_SETTINGS, LABELS);

  const loadStatus = useCallback(() => {
    http.get<MqttStatus>('/api/mqtt/status').then(setStatus, () => undefined);
  }, []);
  useEffect(() => {
    loadStatus();
    const timer = window.setInterval(loadStatus, 5000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);
  useEffect(() => {
    if (!isOwner) return;
    http
      .get<MqttSettings>('/api/settings/mqtt')
      .then(setDraft, (err) => toast({ tone: 'error', title: t("Couldn't load the MQTT settings"), body: errorText(err) }));
  }, [isOwner, toast]);

  const set = <K extends keyof MqttSettings>(k: K, v: MqttSettings[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
    setResult(null);
  };
  const errors: Record<string, string | undefined> = { ...(tried && draft ? extraErrors(draft) : {}), ...check.errors };

  /** True when the form can be sent; otherwise says what's wrong. */
  const valid = (title: string): boolean => {
    if (!draft) return false;
    setTried(true);
    if (!check.ok(title)) return false;
    const extra = Object.values(extraErrors(draft));
    if (extra.length === 0) return true;
    toast({ tone: 'error', title, body: `${extra[0]}.` });
    return false;
  };

  const save = async () => {
    if (!draft || !valid(t("Couldn't save"))) return;
    setBusy('save');
    try {
      const saved = await http.put<MqttSettings>('/api/settings/mqtt', draft);
      setDraft(saved);
      toast({
        tone: 'success',
        title: t('MQTT settings saved'),
        body: saved.enabled ? t('Connecting to the broker…') : t('MQTT is switched off.'),
      });
      loadStatus();
      window.setTimeout(loadStatus, 1500);
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!draft) return;
    if (!draft.url.trim()) {
      setTried(true);
      toast({ tone: 'error', title: t("Couldn't test"), body: t('Enter the broker address first.') });
      return;
    }
    if (!valid(t("Couldn't test"))) return;
    setBusy('test');
    setResult(null);
    try {
      setResult(await http.post<TestResult>('/api/settings/mqtt/test', draft));
    } catch (err) {
      setResult({ ok: false, error: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const chip = CHIPS[status?.state ?? 'off'];
  const topic = draft?.topic || '<topic>';
  const prefix = draft?.discoveryPrefix || 'homeassistant';
  const examplePill = pills.find((p) => !p.archived);
  const pillId = examplePill?.id ?? '<pill id>';

  return (
    <section className="panel mqtt-section">
      <div className="panel-head">
        <div>
          <h2>
            <Icon name="send" /> {t('MQTT and Home Assistant')}
          </h2>
          <p>{t('Publish every reading to an MQTT broker, and add your pills to Home Assistant as devices automatically.')}</p>
        </div>
        {status && <span className={chip.className}>{t(chip.text)}</span>}
      </div>

      {status?.state === 'error' && status.error && (
        <div className="notice danger mqtt-status">
          <Icon name="alert" />
          <p className="grow">
            <strong>{status.error}</strong>
            <span className="small muted">{t('The hub keeps trying in the background. Recording carries on either way.')}</span>
          </p>
        </div>
      )}
      {status?.state === 'connected' && (
        <p className="small muted mqtt-status">
          {status.lastPublishAt
            ? t('Last reading sent {ago}.', { ago: timeAgo(status.lastPublishAt, now) })
            : t('Readings are sent as they arrive.')}
        </p>
      )}

      {!isOwner ? (
        <OwnerOnly isOwner={false}>{null}</OwnerOnly>
      ) : !draft ? (
        <div className="skeleton" style={{ height: '12rem' }} />
      ) : (
        <div className="stack">
          <div className="row">
            <Switch on={draft.enabled} onChange={(on) => set('enabled', on)} label={t('Publish over MQTT')} />
            <span>{t('Publish readings over MQTT')}</span>
          </div>
          <div className="form-grid">
            <label className="field mqtt-wide">
              <span>{t('Broker address')}</span>
              <input
                className="input mono"
                value={draft.url}
                spellCheck={false}
                placeholder="mqtt://homeassistant.local:1883"
                onChange={(e) => set('url', e.target.value)}
              />
              <FieldError error={errors.url} />
              <span className="hint">
                <Trans
                  text={t('{mqtt} (usually port 1883), {mqtts} with TLS (8883), or {ws} / {wss} for MQTT over WebSockets.')}
                  values={{ mqtt: <code>mqtt://</code>, mqtts: <code>mqtts://</code>, ws: <code>ws://</code>, wss: <code>wss://</code> }}
                />
              </span>
            </label>
            <label className="field">
              <span>{t('Username')}</span>
              <input
                className="input"
                value={draft.username}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set('username', e.target.value)}
              />
              <FieldError error={errors.username} />
            </label>
            <label className="field">
              <span>{t('Password')}</span>
              <input
                className="input"
                type="password"
                value={draft.password}
                autoComplete="new-password"
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => set('password', e.target.value)}
              />
              <FieldError error={errors.password} />
            </label>
            <label className="field">
              <span>{t('Base topic')}</span>
              <input className="input mono" value={draft.topic} spellCheck={false} onChange={(e) => set('topic', e.target.value)} />
              <FieldError error={errors.topic} />
            </label>
          </div>

          <label className="check">
            <input type="checkbox" checked={draft.discovery} onChange={(e) => set('discovery', e.target.checked)} />
            <span>
              {t('Add pills to Home Assistant')}
              <small>
                {t(
                  'Each pill appears as a device with gravity, temperature, battery and brew sensors (MQTT discovery). Archived and removed pills are taken away again.',
                )}
              </small>
            </span>
          </label>
          {draft.discovery && (
            <label className="field mqtt-indent">
              <span>{t('Discovery prefix')}</span>
              <input
                className="input mono"
                value={draft.discoveryPrefix}
                spellCheck={false}
                onChange={(e) => set('discoveryPrefix', e.target.value)}
              />
              <FieldError error={errors.discoveryPrefix} />
              <span className="hint">
                <Trans
                  text={t("Leave it as {prefix} unless you changed it in Home Assistant's MQTT options.")}
                  values={{ prefix: <code>homeassistant</code> }}
                />
              </span>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={draft.retain} onChange={(e) => set('retain', e.target.checked)} />
            <span>
              {t('Keep the latest reading on the broker')}
              <small>
                {t('A retained message: anything that subscribes later (like Home Assistant after a restart) gets it straight away.')}
              </small>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.skipImplausible} onChange={(e) => set('skipImplausible', e.target.checked)} />
            <span>
              {t('Skip readings that look wrong')}
              <small>
                {t(
                  "Don't publish a reading when the pill doesn't look like it's floating (lying on its side, or a gravity no beer could have). Home Assistant still hears that it has fallen over.",
                )}
              </small>
            </span>
          </label>

          <div className="row">
            <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void save()}>
              <Icon name="check" /> {busy === 'save' ? t('Saving…') : t('Save')}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void test()}>
              <Icon name="zap" /> {busy === 'test' ? t('Testing…') : t('Test connection')}
            </button>
            {result?.ok && <span className="chip success">{t('Connected fine')}</span>}
          </div>
          {result && !result.ok && (
            <div className="notice danger">
              <Icon name="alert" />
              <p className="grow">
                <strong>{t("The test didn't connect.")}</strong> {result.error}
              </p>
            </div>
          )}
        </div>
      )}

      <details className="mqtt-help">
        <summary>{t('What gets published')}</summary>
        <ul className="mqtt-topics">
          <li>
            <code>{topic}/status</code>:{' '}
            <Trans
              text={t("{online} while the hub is connected, {offline} when it isn't.")}
              values={{ online: <code>online</code>, offline: <code>offline</code> }}
            />
          </li>
          <li>
            <code>
              {topic}/{pillId}/state
            </code>
            :{' '}
            <Trans
              text={t(
                "each new reading as JSON: {gravity} (SG), {gravity_plato}, {temperature} (°C), {velocity} (points/day), {battery} (%), {rssi} (dBm), {tilt} (°), {plausible}, {timestamp}, and the running brew's {brew_name}, {og}, {abv}, {attenuation} and {stage} (empty when there's no brew).",
              )}
              values={STATE_CODES}
            />
          </li>
          <li>
            <code>
              {topic}/{pillId}/plausible
            </code>
            : <Trans text={t("{false} when the pill doesn't look like it's floating.")} values={{ false: <code>false</code> }} />
          </li>
          <li>
            <code>
              {prefix}/sensor/rapthooker_{pillId}/…/config
            </code>
            : {t("Home Assistant discovery, when it's on.")}
          </li>
        </ul>
        {pills.some((p) => !p.archived) && (
          <p className="small muted">
            {t('Pill ids: {list}.', {
              list: pills
                .filter((p) => !p.archived)
                .map((p) => `${p.name} = ${p.id}`)
                .join(', '),
            })}
          </p>
        )}
        <p className="small">
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            {t('Setting up Home Assistant')} <Icon name="external" size={14} />
          </a>
        </p>
      </details>
    </section>
  );
}
