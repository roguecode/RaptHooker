import { useCallback, useEffect, useState } from 'react';
import { alertKindInfo, type AlertEvent, type AlertRule, type AlertRuleInput, type Channel } from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { useUnits } from '../../units';
import { timeAgo, useNow } from '../../format';
import { Icon } from '../../components/Icon';
import { Confirm, Switch } from '../../components/ui';
import { t, tp } from '../../i18n';
import { PushPanel } from './PushPanel';
import { ChannelsPanel } from './ChannelsPanel';
import { RuleModal, emptyRule, sendToText } from './RuleModal';
import { channelApi } from './channelApi';
import './alerts.css';

export function AlertsPage() {
  const { isOwner, pills, toast } = useLive();
  const u = useUnits();
  const now = useNow(30_000);
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; input: AlertRuleInput } | null>(null);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);
  const pillName = (id: string) => pills.find((p) => p.id === id)?.name ?? t('removed pill');

  const load = useCallback(async () => {
    try {
      const [r, e] = await Promise.all([api.alertRules(), api.alertEvents(40)]);
      setRules(r);
      setEvents(e);
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't load alerts"), body: errorText(err) });
    }
  }, [toast]);
  const loadChannels = useCallback(async () => {
    try {
      setChannels(await channelApi.list());
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't load where alerts go"), body: errorText(err) });
    }
  }, [toast]);
  const reloadAll = useCallback(() => {
    void load();
    void loadChannels();
  }, [load, loadChannels]);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);
  useEffect(() => {
    if (!editing) return;
    void loadChannels();
  }, [editing, loadChannels]);
  useLiveMessages((m) => {
    if (m.type !== 'alert') return;
    void load();
    // Sending through the services takes a moment (up to 10 s when one doesn't answer).
    window.setTimeout(() => void loadChannels(), 2_000);
    window.setTimeout(() => void loadChannels(), 12_000);
  });

  const describe = (r: AlertRule) => {
    const info = alertKindInfo(r.kind);
    switch (info.measure) {
      case 'temperature':
        return `${t(info.label)} ${u.tempText(r.threshold)}`;
      case 'gravity':
        return `${t(info.label)} ${u.gravityText(r.threshold)}`;
      case 'points':
        return tp(r.threshold, 'Less than {count} point change in {hours} h', 'Less than {count} points change in {hours} h', {
          hours: r.hours,
        });
      case 'percent':
        return `${t(info.label)} ${r.threshold}%`;
      default:
        return t('Nothing heard for {minutes} min', { minutes: r.threshold });
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Alerts')}</h1>
          <p>{t('Get told when a brew gets too warm, reaches its target, finishes fermenting or a pill goes quiet.')}</p>
        </div>
        {isOwner && (
          <button type="button" className="btn primary" onClick={() => setEditing({ id: null, input: emptyRule() })}>
            <Icon name="plus" /> {t('New alert')}
          </button>
        )}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>
            <Icon name="alert" /> {t('Rules')}
          </h2>
        </div>
        {rules === null ? null : rules.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('No alerts yet.')}
            {isOwner ? ` ${t('Add one to get notified.')}` : ''}
          </p>
        ) : (
          <div className="list">
            {rules.map((r) => (
              <div key={r.id} className="list-item">
                <Switch
                  on={r.enabled}
                  disabled={!isOwner}
                  label={t('Enabled')}
                  onChange={(on) => {
                    const { id: _id, createdAt: _c, active: _a, ...input } = r;
                    api.updateAlert(r.id, { ...input, enabled: on }).then(
                      () => load(),
                      (e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }),
                    );
                  }}
                />
                <div className="grow">
                  <h4>
                    {r.name}{' '}
                    {r.active.length > 0 && (
                      <span className="chip warning">{t('Firing: {pills}', { pills: r.active.map(pillName).join(', ') })}</span>
                    )}
                  </h4>
                  <p>
                    {describe(r)} · {r.pillIds === 'all' ? t('all pills') : r.pillIds.map(pillName).join(', ')}
                    {r.onlyDuringBrew ? ` · ${t('while brewing')}` : ''}
                  </p>
                  <p className="rule-send-to">
                    <Icon name="send" size={12} /> {sendToText(r.channelIds, channels ?? [])}
                  </p>
                </div>
                {isOwner && (
                  <>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => {
                        const { id, createdAt: _c, active: _a, ...input } = r;
                        setEditing({ id, input });
                      }}
                    >
                      <Icon name="pencil" size={14} /> {t('Edit')}
                    </button>
                    <button type="button" className="btn small icon ghost" aria-label={t('Delete')} onClick={() => setDeleting(r)}>
                      <Icon name="trash" size={16} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <ChannelsPanel channels={channels} rules={rules ?? []} reload={reloadAll} />

      <PushPanel />

      <section className="panel">
        <div className="panel-head">
          <h2>
            <Icon name="clock" /> {t('Recent')}
          </h2>
        </div>
        {events.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('Nothing yet.')}
          </p>
        ) : (
          <div className="list">
            {events.map((e) => (
              <div key={e.id} className="list-item">
                {/* i18n: "OK" means the alert's condition is back to normal */}
                <span className={`chip ${e.kind === 'fired' ? 'warning' : 'success'}`}>{e.kind === 'fired' ? t('Alert') : t('OK')}</span>
                <div className="grow">
                  <h4>{e.ruleName}</h4>
                  <p>{e.message}</p>
                </div>
                <span className="small muted">{timeAgo(e.at, now)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <RuleModal
          isNew={editing.id === null}
          initial={editing.input}
          channels={channels ?? []}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            if (editing.id) await api.updateAlert(editing.id, input);
            else await api.createAlert(input);
            await load();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title={t('Delete "{name}"?', { name: deleting.name })}
          body={<p>{t("You won't be notified for it any more.")}</p>}
          confirm={t('Delete')}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => api.deleteAlert(deleting.id).then(load, (e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }))}
        />
      )}
    </div>
  );
}
