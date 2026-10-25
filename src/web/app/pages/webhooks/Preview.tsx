import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildBatchContext,
  buildContext,
  renderBatchRequest,
  renderRequest,
  sampleReading,
  type Brew,
  type PillInfo,
  type Reading,
  type WebhookDelivery,
  type WebhookInput,
} from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive } from '../../live';
import { t, tp } from '../../i18n';
import { Icon } from '../../components/Icon';
import { DeliveryDetail } from './DeliveryLog';
import { warningText } from './strings';

const SAMPLE_PILL = {
  id: 'sample',
  name: 'Sample Pill',
  address: '00:00:00:00:00:02',
  raptId: '00:00:00:00:00:00',
  info: { firmware: '20250319_000000_sample', deviceType: 'PillG1', payloadVersion: 2 } as PillInfo,
};

/** The request as it would be sent for one pill (or all of them in batch mode), with a button to send it for real. */
export function Preview({ draft, webhookId, canSend }: { draft: WebhookInput; webhookId: string | null; canSend: () => boolean }) {
  const { pills, toast, hub } = useLive();
  const [previewPill, setPreviewPill] = useState<string>(pills.find((p) => p.live.latest)?.id ?? 'sample');
  const pickedPreview = useRef(false);
  useEffect(() => {
    if (pickedPreview.current || previewPill !== 'sample') return;
    const first = pills.find((p) => p.live.latest);
    if (first) setPreviewPill(first.id);
  }, [pills, previewPill]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebhookDelivery | null>(null);
  const [version, setVersion] = useState('');

  useEffect(() => {
    api.status().then(
      (s) => setVersion(s.version),
      () => undefined,
    );
  }, []);

  const batchPills = useMemo(
    () => pills.filter((p) => !p.archived && p.live.latest && (draft.pillIds === 'all' || draft.pillIds.includes(p.id))),
    [pills, draft.pillIds],
  );

  const preview = useMemo(() => {
    const now = Date.now();
    const appVersion = version || '0.3.0';
    const intervalSec = Math.round(draft.intervalMin * 60);
    const ctx = (pill: typeof SAMPLE_PILL, reading: Reading, brew: Brew | null) =>
      buildContext({
        pill,
        reading,
        brew,
        gravityUnit: draft.gravityUnit,
        temperatureUnit: draft.temperatureUnit,
        intervalSec,
        now,
        appVersion,
        hubName: hub.name,
      });
    if (draft.batch) {
      const items = batchPills.length
        ? batchPills.map((p) => ctx(p, p.live.latest!, p.brew))
        : [ctx(SAMPLE_PILL, sampleReading(now), null)];
      return renderBatchRequest(draft, items, buildBatchContext({ count: items.length, now, intervalSec, appVersion, hubName: hub.name }));
    }
    const pill = pills.find((p) => p.id === previewPill);
    return renderRequest(draft, ctx(pill ?? SAMPLE_PILL, pill?.live.latest ?? sampleReading(now), pill?.brew ?? null));
  }, [draft, previewPill, pills, batchPills, version, hub.name]);

  const prettyBody = useMemo(() => {
    if (preview.body === null) return null;
    if (draft.bodyFormat !== 'json') return preview.body;
    try {
      return JSON.stringify(JSON.parse(preview.body), null, 2);
    } catch {
      return preview.body;
    }
  }, [preview.body, draft.bodyFormat]);

  const test = async () => {
    if (!canSend()) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testWebhook(draft, webhookId, previewPill === 'sample' ? null : previewPill));
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't send the test"), body: errorText(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="panel stack">
      <div className="panel-head" style={{ marginBottom: 0 }}>
        <h3>
          <Icon name="send" /> {t('Preview')}
        </h3>
        {draft.batch ? (
          <span className="small muted">
            {batchPills.length ? tp(batchPills.length, '{count} pill in one request', '{count} pills in one request') : t('Sample reading')}
          </span>
        ) : (
          <select
            className="select"
            style={{ width: 'auto', minHeight: '2.2rem' }}
            value={previewPill}
            onChange={(e) => {
              pickedPreview.current = true;
              setPreviewPill(e.target.value);
            }}
          >
            {pills.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="sample">{t('Sample reading')}</option>
          </select>
        )}
      </div>
      <div className="code-block">
        <span className="method">{preview.method}</span> {preview.url}
        {preview.contentType && `\nContent-Type: ${preview.contentType}`}
        {preview.headers.map((h) => `\n${h.name}: ${h.value}`).join('')}
        {prettyBody !== null && `\n\n${prettyBody}`}
      </div>
      {preview.warnings.length > 0 && (
        <div className="notice warning">
          <Icon name="alert" />
          <div className="grow small">
            {preview.warnings.map((w) => (
              <div key={w}>{warningText(w)}</div>
            ))}
          </div>
        </div>
      )}
      <div className="row">
        <button type="button" className="btn" disabled={testing || !/^https?:\/\//i.test(preview.url)} onClick={() => void test()}>
          <Icon name="zap" size={16} /> {testing ? t('Sending…') : t('Send a test now')}
        </button>
        <span className="small muted">
          {draft.batch ? t("Sends every chosen pill's latest reading.") : t("Uses the preview pill's latest reading.")}
        </span>
      </div>
      {testResult && <DeliveryDetail d={testResult} open />}
    </section>
  );
}
