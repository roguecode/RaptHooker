import { useState } from 'react';
import type { AlertRule, Channel } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { timeAgo, useNow } from '../../format';
import { Icon } from '../../components/Icon';
import { Confirm, OwnerOnly, Switch } from '../../components/ui';
import { t } from '../../i18n';
import { ChannelIcon } from './ChannelIcon';
import { ChannelEditor } from './ChannelEditor';
import { channelApi, toChannelInput } from './channelApi';
import { channelKindLabel } from './strings';

function LastResult({ channel, now }: { channel: Channel; now: number }) {
  if (channel.lastAt === null) return <>{t('Not used yet')}</>;
  if (channel.lastOk) {
    return (
      <>
        <span className="chip success">{t('Sent')}</span> {timeAgo(channel.lastAt, now)}
      </>
    );
  }
  return (
    <>
      <span className="chip danger">{t('Failed')}</span> {timeAgo(channel.lastAt, now)}
      {channel.lastError ? `: ${channel.lastError}` : ''}
    </>
  );
}

/** "Where alerts go": the services alerts are sent through besides browser notifications. */
export function ChannelsPanel({ channels, rules, reload }: { channels: Channel[] | null; rules: AlertRule[]; reload: () => void }) {
  const { isOwner, toast } = useLive();
  const now = useNow(30_000);
  const [editing, setEditing] = useState<{ channel: Channel | null } | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const usedBy = (id: string) => rules.filter((r) => r.channelIds !== 'all' && r.channelIds.includes(id));

  const setEnabled = (c: Channel, enabled: boolean) =>
    channelApi
      .update(c.id, { ...toChannelInput(c), enabled })
      .then(reload, (e) => toast({ tone: 'error', title: t("Couldn't change it"), body: errorText(e) }));

  const test = async (c: Channel) => {
    setTesting(c.id);
    try {
      await channelApi.test(toChannelInput(c), c.id);
      toast({
        tone: 'success',
        title: t('Test sent'),
        body: t('Check {service} for a message from RaptHooker.', { service: channelKindLabel(c.kind) }),
      });
    } catch (err) {
      toast({ tone: 'error', title: t('Test failed'), body: errorText(err) });
    } finally {
      setTesting(null);
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>
              <Icon name="send" /> {t('Where alerts go')}
            </h2>
            <p>{t('Get alerts on your phone through ntfy, Pushover, Telegram, Discord or email, wherever you are.')}</p>
          </div>
          {isOwner && (
            <button type="button" className="btn small" onClick={() => setEditing({ channel: null })}>
              <Icon name="plus" size={14} /> {t('Add')}
            </button>
          )}
        </div>
        {channels === null ? null : channels.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('Nothing added yet.')}
            {isOwner ? ` ${t('Add a service to get alerts even when this app is closed.')}` : ''}
          </p>
        ) : (
          <div className="list">
            {channels.map((c) => (
              <div key={c.id} className={`list-item channel-row${c.enabled ? '' : ' channel-off'}`}>
                <span className="channel-kind" title={channelKindLabel(c.kind)}>
                  <ChannelIcon kind={c.kind} />
                </span>
                <div className="grow">
                  <h4>
                    {c.name} <span className="faint small">{channelKindLabel(c.kind)}</span>
                  </h4>
                  <p>{c.enabled ? <LastResult channel={c} now={now} /> : t('Switched off')}</p>
                </div>
                <div className="channel-actions">
                  <Switch on={c.enabled} disabled={!isOwner} label={t('Switched on')} onChange={(on) => void setEnabled(c, on)} />
                  {isOwner && (
                    <>
                      <button type="button" className="btn small" disabled={testing === c.id} onClick={() => void test(c)}>
                        <Icon name="send" size={14} /> {t('Test')}
                      </button>
                      <button type="button" className="btn small" onClick={() => setEditing({ channel: c })}>
                        <Icon name="pencil" size={14} /> {t('Edit')}
                      </button>
                      <button
                        type="button"
                        className="btn small icon ghost"
                        aria-label={t('Delete {name}', { name: c.name })}
                        onClick={() => setDeleting(c)}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {!isOwner && channels !== null && channels.length > 0 && (
          <p className="hint">{t('Keys, topics and addresses are only shown to the owner.')}</p>
        )}
        {!isOwner && <OwnerOnly isOwner={false}>{null}</OwnerOnly>}
      </section>

      {editing && <ChannelEditor channel={editing.channel} onClose={() => setEditing(null)} onSaved={reload} />}
      {deleting && (
        <Confirm
          title={t('Delete "{name}"?', { name: deleting.name })}
          body={
            usedBy(deleting.id).length > 0 ? (
              <p>
                {t('{rules} will stop sending here.', {
                  rules: usedBy(deleting.id)
                    .map((r) => r.name)
                    .join(', '),
                })}
              </p>
            ) : (
              <p>{t("Alerts won't be sent here any more.")}</p>
            )
          }
          confirm={t('Delete')}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            channelApi.remove(deleting.id).then(reload, (e) => toast({ tone: 'error', title: t("Couldn't delete it"), body: errorText(e) }))
          }
        />
      )}
    </>
  );
}
