import { useCallback, useEffect, useState } from 'react';
import type { AlertEvent } from '@rapthooker/shared';
import { api, errorText } from '../api';
import { useLive, useLiveMessages } from '../live';
import { timeAgo, useNow } from '../format';
import { t, tp } from '../i18n';
import { Icon } from './Icon';
import { TopbarMenu } from './TopbarMenu';

/** The most the menu lists (the hub keeps the latest 500 alerts). */
const SHOWN = 100;

/** Alerts that went off and wait to be acknowledged, newest first, kept up to date by the live connection. */
export function useUnackedAlerts(): { events: AlertEvent[]; ack: (ids: number[] | 'all') => Promise<void> } {
  const { toast } = useLive();
  const [events, setEvents] = useState<AlertEvent[]>([]);

  const load = useCallback(() => {
    api.alertEvents(SHOWN, undefined, { unacked: true }).then(setEvents, () => undefined);
  }, []);
  useEffect(load, [load]);
  useLiveMessages((m) => {
    if (m.type === 'hello' || m.type === 'pill-removed') load();
    else if (m.type === 'alert' && m.event.kind === 'fired' && m.event.ackedAt === null)
      setEvents((cur) => (cur.some((e) => e.id === m.event.id) ? cur : [m.event, ...cur].slice(0, SHOWN)));
    else if (m.type === 'alert-acks') setEvents((cur) => cur.filter((e) => !m.ids.includes(e.id)));
  });

  const ack = useCallback(
    async (ids: number[] | 'all') => {
      setEvents((cur) => (ids === 'all' ? [] : cur.filter((e) => !ids.includes(e.id))));
      try {
        await api.ackAlerts(ids);
      } catch (err) {
        toast({ tone: 'error', title: t("Couldn't acknowledge the alert"), body: errorText(err) });
        load();
      }
    },
    [toast, load],
  );
  return { events, ack };
}

/** Where an alert is about: its brew (a brew's own alert, a reminder, or one that went off in a brew), else its device. */
function alertLink(e: AlertEvent, pillKnown: boolean): string | null {
  if (e.brewId) return `#/brew/${encodeURIComponent(e.brewId)}`;
  return pillKnown ? `#/pill/${encodeURIComponent(e.pillId)}` : null;
}

/** The top bar's bell: glows while alerts wait to be acknowledged, and lists them to open or acknowledge. */
export function AlertsMenu() {
  const { pills, isOwner } = useLive();
  const { events, ack } = useUnackedAlerts();
  const now = useNow(30_000);
  const count = events.length;
  const label = count ? tp(count, '{count} alert to acknowledge', '{count} alerts to acknowledge') : t('No alerts to acknowledge');

  return (
    <TopbarMenu
      label={label}
      icon="bell"
      className="alerts-pop"
      buttonClassName={count ? 'alerts-btn alerting' : 'alerts-btn'}
      badge={
        count > 0 && (
          <span className="alerts-count" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )
      }
    >
      <div className="alerts-pop-head">
        <strong>{t('Alerts to acknowledge')}</strong>
        {isOwner && count > 1 && (
          <button type="button" className="btn small ghost" onClick={() => void ack('all')}>
            <Icon name="check" size={14} /> {t('Acknowledge all')}
          </button>
        )}
      </div>
      {count === 0 ? (
        <p className="alerts-pop-empty">
          <Icon name="circleCheck" size={18} /> {t('Nothing needs looking at.')}
        </p>
      ) : (
        <ul className="alerts-pop-list">
          {events.map((e) => {
            const pill = pills.find((p) => p.id === e.pillId);
            const href = alertLink(e, pill !== undefined);
            const body = (
              <>
                <Icon name="alert" size={16} />
                <span className="alerts-pop-text">
                  <strong>{e.ruleName}</strong>
                  {e.message && <span className="small">{e.message}</span>}
                  <span className="small faint">
                    {pill ? `${pill.name} · ` : ''}
                    {timeAgo(e.at, now)}
                  </span>
                </span>
              </>
            );
            return (
              <li key={e.id} className="alerts-pop-item">
                {href ? (
                  <a className="alerts-pop-link" href={href} title={e.brewId ? t('Open the brew') : t('Open the device')}>
                    {body}
                  </a>
                ) : (
                  <div className="alerts-pop-link">{body}</div>
                )}
                {isOwner && (
                  <button
                    type="button"
                    className="btn small icon ghost"
                    aria-label={t('Acknowledge "{name}"', { name: e.ruleName })}
                    title={t('Acknowledge')}
                    onClick={() => void ack([e.id])}
                  >
                    <Icon name="check" size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <a className="menu-item" href="#/alerts">
        <Icon name="bell" /> {t('All alerts')}
        <span className="small faint">{t('Rules, where alerts go, and what went off lately')}</span>
      </a>
    </TopbarMenu>
  );
}
