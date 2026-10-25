import { useCallback, useEffect, useState } from 'react';
import type { WebhookDelivery } from '@rapthooker/shared';
import { api } from '../../api';
import { useLiveMessages } from '../../live';
import { dateTime } from '../../format';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';

export function DeliveryDetail({ d, open = false }: { d: WebhookDelivery; open?: boolean }) {
  const [show, setShow] = useState(open);
  return (
    <div>
      <div className="delivery" onClick={() => setShow((s) => !s)}>
        <span className={`chip ${d.ok ? 'success' : 'danger'}`}>{d.status ?? t('Error')}</span>
        <span className="small" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {dateTime(d.at)}
          {/* i18n: "test" marks a test delivery in the log */}
          {d.test ? ` · ${t('test')}` : ''}
          {d.error ? ` · ${d.error}` : ''}
        </span>
        <span className="small muted">{d.durationMs} ms</span>
      </div>
      {show && (
        <div className="delivery-detail stack" style={{ gap: '0.4rem' }}>
          <div className="code-block">
            <span className="method">{d.method}</span> {d.url}
            {d.requestBody ? `\n\n${d.requestBody}` : ''}
          </div>
          <div className="small muted">{t('Response')}</div>
          <div className="code-block">{d.responseBody || d.error || t('(empty)')}</div>
        </div>
      )}
    </div>
  );
}

export function DeliveryLog({ webhookId }: { webhookId: string }) {
  const [list, setList] = useState<WebhookDelivery[] | null>(null);
  const load = useCallback(() => {
    api.deliveries(webhookId).then(setList, () => setList([]));
  }, [webhookId]);
  useEffect(load, [load]);
  useLiveMessages((m) => {
    if (m.type === 'webhook' && m.webhookId === webhookId) load();
  });
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>
          <Icon name="list" /> {t('Recent deliveries')}
        </h3>
        <button type="button" className="btn small ghost" onClick={load}>
          <Icon name="refresh" size={14} /> {t('Refresh')}
        </button>
      </div>
      {list === null ? null : list.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          {t('Nothing sent yet.')}
        </p>
      ) : (
        list.map((d) => <DeliveryDetail key={d.id} d={d} />)
      )}
    </section>
  );
}
