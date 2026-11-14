import { useCallback, useEffect, useState } from 'react';
import {
  alertInputOf,
  ONCE_PER_BREW,
  type AlertRule,
  type AlertRuleInput,
  type Brew,
  type BrewAlert,
  type Channel,
} from '@rapthooker/shared';
import { api, errorText } from '../../api';
import { useLive, useLiveMessages } from '../../live';
import { useUnits } from '../../units';
import { timeAgo, useNow } from '../../format';
import { Icon } from '../../components/Icon';
import { Confirm, Switch } from '../../components/ui';
import { t } from '../../i18n';
import { RuleModal } from '../alerts/RuleModal';
import { channelApi } from '../alerts/channelApi';
import { describeAlert } from '../alerts/describe';
import { brewApi } from './api';
import { brewInputOf, newBrewAlert, ruleInputOf } from './brewAlertInput';
import { SaveProfileModal, UseProfileModal } from './profiles';

/** A brew's own alerts (and the hub's rules that watch it too), with its profile actions. */
export function BrewAlertsSection({ brew, onChanged }: { brew: Brew; onChanged?: () => void }) {
  const { isOwner, toast } = useLive();
  const u = useUnits();
  const now = useNow(30_000);
  const [alerts, setAlerts] = useState<BrewAlert[] | null>(null);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: AlertRuleInput } | null>(null);
  const [deleting, setDeleting] = useState<BrewAlert | null>(null);
  const [profile, setProfile] = useState<'save' | 'use' | null>(null);
  const running = brew.endedAt === null;

  const load = useCallback(() => {
    brewApi.alerts(brew.id).then(setAlerts, (err) => toast({ tone: 'error', title: t("Couldn't load alerts"), body: errorText(err) }));
    // Only for the line about the hub's other alerts.
    api.alertRules().then(setRules, () => undefined);
  }, [brew.id, toast]);
  useEffect(load, [load]);
  useLiveMessages((m) => {
    if (m.type === 'alert' && m.event.pillId === brew.pillId) load();
    // Whether one is still waiting for the gravity changes with the readings.
    else if (m.type === 'reading' && m.pillId === brew.pillId && alerts?.some((a) => a.waitingForGravity != null)) load();
  });
  useEffect(() => {
    if (editing) channelApi.list().then(setChannels, () => undefined);
  }, [editing]);

  const save = async (input: AlertRuleInput) => {
    const body = brewInputOf(input);
    if (editing?.id) await brewApi.updateAlert(brew.id, editing.id, body);
    else await brewApi.addAlert(brew.id, body);
    load();
  };
  // The hub's rules that watch this brew's pill too.
  const also = rules.filter((r) => r.enabled && (r.pillIds === 'all' || r.pillIds.includes(brew.pillId)));

  return (
    <div className="stack" style={{ gap: '0.6rem' }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <h3 className="spacer ev-head">
          <Icon name="alert" size={16} /> {t('Alerts for this brew')}
        </h3>
        {isOwner && running && (
          <button type="button" className="btn small ghost" onClick={() => setProfile('use')}>
            <Icon name="layers" size={14} /> {t('Use a profile')}
          </button>
        )}
        {isOwner && (
          <button type="button" className="btn small ghost" onClick={() => setProfile('save')}>
            <Icon name="copy" size={14} /> {t('Save as a profile')}
          </button>
        )}
        {isOwner && running && (
          <button type="button" className="btn small" onClick={() => setEditing({ id: null, input: newBrewAlert() })}>
            <Icon name="plus" size={14} /> {t('Add alert')}
          </button>
        )}
      </div>
      {alerts === null ? null : alerts.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          {running
            ? t(
                'Alerts that watch this brew alone, from when it starts: when fermentation gets going, a gravity or attenuation to dry hop at, a day to take a sample. They go when the brew ends.',
              )
            : t('No alerts of its own.')}
        </p>
      ) : (
        <div className="list">
          {alerts.map((a) => (
            <div key={a.id} className="list-item">
              <Switch
                on={a.enabled}
                disabled={!isOwner || !running}
                label={t('Enabled')}
                onChange={(on) =>
                  brewApi
                    .updateAlert(brew.id, a.id, { ...alertInputOf(a), enabled: on })
                    .then(load, (e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }))
                }
              />
              <div className="grow">
                <h4>
                  {a.name} {a.active && !ONCE_PER_BREW.has(a.kind) && <span className="chip warning">{t('Going off')}</span>}
                </h4>
                <p>
                  {describeAlert(a, u)}
                  {ONCE_PER_BREW.has(a.kind) ? ` · ${t('once a brew')}` : ''}
                </p>
                {a.message && <p className="rule-todo">“{a.message}”</p>}
                <p className="brew-alert-state muted">
                  {a.lastFiredAt !== null && a.lastFiredAt >= brew.startedAt
                    ? t('Went off {time}', { time: timeAgo(a.lastFiredAt, now) })
                    : running
                      ? a.enabled
                        ? a.waitingForGravity != null
                          ? t('Waiting for the gravity to reach {gravity}, 2 points below where the pill started', {
                              gravity: u.gravityText(a.waitingForGravity),
                            })
                          : t('Watching')
                        : t('Switched off')
                      : t("Didn't go off")}
                </p>
              </div>
              {isOwner && (
                <>
                  <button type="button" className="btn small" onClick={() => setEditing({ id: a.id, input: ruleInputOf(alertInputOf(a)) })}>
                    <Icon name="pencil" size={14} /> {t('Edit')}
                  </button>
                  <button type="button" className="btn small icon ghost" aria-label={t('Delete')} onClick={() => setDeleting(a)}>
                    <Icon name="trash" size={16} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {running && also.length > 0 && (
        <p className="brew-alerts-also muted">
          {t('Also watching it, from Alerts: {names}.', { names: also.map((r) => r.name).join(', ') })}
        </p>
      )}
      {editing && (
        <RuleModal
          brew={{ name: brew.name }}
          isNew={editing.id === null}
          initial={editing.input}
          channels={channels}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
      {deleting && (
        <Confirm
          title={t('Delete "{name}"?', { name: deleting.name })}
          body={<p>{t("You won't be notified for it any more.")}</p>}
          confirm={t('Delete')}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            brewApi.deleteAlert(brew.id, deleting.id).then(load, (e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }))
          }
        />
      )}
      {profile === 'save' && <SaveProfileModal brew={brew} alerts={alerts ?? []} onClose={() => setProfile(null)} />}
      {profile === 'use' && (
        <UseProfileModal
          brew={brew}
          onClose={() => setProfile(null)}
          onUsed={() => {
            load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
