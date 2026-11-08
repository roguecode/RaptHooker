import { useCallback, useEffect, useState } from 'react';
import {
  brewProfileInputSchema,
  profileEventSchema,
  profileFromBrew,
  type AlertRuleInput,
  type Brew,
  type BrewAlert,
  type BrewAlertInput,
  type BrewEventKind,
  type BrewProfile,
  type Channel,
  type ProfileEvent,
} from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { days } from '../../format';
import { Icon } from '../../components/Icon';
import { Confirm, Modal } from '../../components/ui';
import { FieldError, useFormCheck } from '../../validation';
import { t, tk, tp } from '../../i18n';
import { describeAlert } from '../alerts/describe';
import { RuleModal } from '../alerts/RuleModal';
import { channelApi } from '../alerts/channelApi';
import { brewApi } from './api';
import { brewInputOf, newBrewAlert, ruleInputOf } from './brewAlertInput';
import { brewDay, EVENT_KINDS, eventKind } from './brewText';

/** The hub's brew profiles, loaded once (null until then; none if they couldn't be loaded, as they're only extras). */
export function useProfiles(): [BrewProfile[] | null, () => void] {
  const [profiles, setProfiles] = useState<BrewProfile[] | null>(null);
  const load = useCallback(() => {
    brewApi.profiles().then(setProfiles, () => setProfiles([]));
  }, []);
  useEffect(load, [load]);
  return [profiles, load];
}

/** "2 alerts, 3 planned events". */
export function profileCounts(p: Pick<BrewProfile, 'alerts' | 'events'>): string {
  return [
    tp(p.alerts.length, '{count} alert', '{count} alerts'),
    tp(p.events.length, '{count} planned event', '{count} planned events'),
  ].join(', ');
}

/** What a profile adds to a brew: its alerts, and its events by day. */
export function ProfileContents({ profile }: { profile: Pick<BrewProfile, 'alerts' | 'events'> }) {
  const u = useUnits();
  if (profile.alerts.length === 0 && profile.events.length === 0) return <p className="muted small">{t('Nothing in it yet.')}</p>;
  return (
    <ul className="profile-summary">
      {profile.alerts.map((a, i) => (
        <li key={`a${i}`}>
          <Icon name="alert" size={12} /> <strong>{a.name}</strong>: {describeAlert(a, u)}
          {a.message ? ` · “${a.message}”` : ''}
        </li>
      ))}
      {profile.events.map((e, i) => {
        const label = e.kind === 'note' ? t('Note') : t(eventKind(e.kind).label);
        const lasts = e.endOffset !== null ? ` (${days(e.endOffset - e.offset)})` : '';
        return (
          <li key={`e${i}`}>
            <Icon name="calendar" size={12} /> {brewDay(0, e.offset)}: <strong>{label}</strong>
            {e.text ? `: ${e.text}` : ''}
            {lasts}
            {e.remind && (
              <>
                {' '}
                <Icon name="bell" size={12} />
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const LABELS = { name: tk('Name'), notes: tk('Notes') };

/** Saves a brew's own alerts and its events (timed from its start) as a profile, new or in place of one. */
export function SaveProfileModal({ brew, alerts, onClose }: { brew: Brew; alerts: BrewAlert[]; onClose: () => void }) {
  const { toast } = useLive();
  const [profiles] = useProfiles();
  const [target, setTarget] = useState<string>('new');
  const [name, setName] = useState(brew.style || brew.name);
  const [notes, setNotes] = useState('');
  const [remind, setRemind] = useState(true);
  const [busy, setBusy] = useState(false);
  const input = profileFromBrew(brew, alerts, { name: name.trim(), notes, remind });
  const check = useFormCheck(brewProfileInputSchema, input, LABELS);
  const pick = (id: string) => {
    setTarget(id);
    const p = profiles?.find((x) => x.id === id);
    if (p) {
      setName(p.name);
      setNotes(p.notes);
    }
  };

  return (
    <Modal title={t('Save as a profile')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!check.ok(t("Couldn't save"))) return;
          setBusy(true);
          try {
            const saved = target === 'new' ? await brewApi.addProfile(input) : await brewApi.updateProfile(target, input);
            toast({ tone: 'success', title: t('Saved "{name}"', { name: saved.name }), body: t('Pick it when you start a brew.') });
            onClose();
          } catch (err) {
            toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted small" style={{ margin: 0 }}>
          {t("A profile keeps this brew's own alerts and its events, timed from its start, for a brew you start with it.")}
        </p>
        {(profiles?.length ?? 0) > 0 && (
          <label className="field">
            <span>{t('Save as')}</span>
            <select className="select" value={target} onChange={(e) => pick(e.target.value)}>
              <option value="new">{t('A new profile')}</option>
              {profiles!.map((p) => (
                <option key={p.id} value={p.id}>
                  {t('In place of "{name}"', { name: p.name })}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t('Name')}</span>
          <input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <FieldError error={check.errors.name} />
        </label>
        <label className="field">
          <span>{t('Notes')}</span>
          <textarea
            className="textarea"
            rows={2}
            maxLength={2000}
            value={notes}
            placeholder={t('Yeast, hops, dry hop schedule…')}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
          <span>
            {t('Remind me of its events')}
            <small>{t('In a brew started with it, each one notifies you when its time comes.')}</small>
          </span>
        </label>
        <div className="field">
          <span>{profileCounts(input)}</span>
          <ProfileContents profile={input} />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {t('Save profile')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Adds a profile's alerts and planned events to a running brew. */
export function UseProfileModal({ brew, onClose, onUsed }: { brew: Brew; onClose: () => void; onUsed: () => void }) {
  const { toast } = useLive();
  const [profiles] = useProfiles();
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const profile = profiles?.find((p) => p.id === id) ?? profiles?.[0];

  return (
    <Modal title={t('Use a profile')} onClose={onClose}>
      {profiles === null ? (
        <div className="skeleton" style={{ height: '6rem' }} />
      ) : profiles.length === 0 ? (
        <p className="muted">
          {t('No profiles yet. Make one under Profiles on the Brews page, or save one from a brew whose alerts and events you want again.')}
        </p>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!profile) return;
            setBusy(true);
            try {
              await brewApi.applyProfile(brew.id, profile.id);
              toast({ tone: 'success', title: t('Added "{name}" to {brew}', { name: profile.name, brew: brew.name }) });
              onUsed();
              onClose();
            } catch (err) {
              toast({ tone: 'error', title: t("Couldn't use the profile"), body: errorText(err) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span>{t('Profile')}</span>
            <select className="select" value={profile?.id ?? ''} onChange={(e) => setId(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {profile && (
            <div className="field">
              <span>{t('Adds to this brew, timed from its start ({profile})', { profile: profileCounts(profile) })}</span>
              <ProfileContents profile={profile} />
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={busy || !profile}>
              {t('Add to the brew')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** The profiles, on the Brews page: what's in each, made, changed or deleted by the owner. */
export function ProfilesPanel() {
  const { isOwner, toast } = useLive();
  const [profiles, reload] = useProfiles();
  // 'new' for one made here.
  const [editing, setEditing] = useState<BrewProfile | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BrewProfile | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (profiles === null) return null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Icon name="layers" /> {t('Profiles')}
        </h2>
        <span className="chip">{profiles.length}</span>
        {isOwner && (
          <button type="button" className="btn small" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('New profile')}
          </button>
        )}
      </div>
      {profiles.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {t(
            "Like a RAPT Pill profile: alerts and planned events (a dry hop on day 3) a brew starts with. Make one with New profile, or save a brew's from its page, under Alerts for this brew.",
          )}
        </p>
      ) : (
        <div className="list">
          {profiles.map((p) => (
            <div key={p.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <div className="grow">
                <h4>{p.name}</h4>
                <p>
                  {profileCounts(p)}
                  {p.notes ? ` · ${p.notes}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="btn small ghost"
                aria-expanded={open === p.id}
                onClick={() => setOpen(open === p.id ? null : p.id)}
              >
                {open === p.id ? t('Hide') : t('Show')}
              </button>
              {isOwner && (
                <>
                  <button type="button" className="btn small" onClick={() => setEditing(p)}>
                    <Icon name="pencil" size={14} /> {t('Edit')}
                  </button>
                  <button type="button" className="btn small icon ghost" aria-label={t('Delete')} onClick={() => setDeleting(p)}>
                    <Icon name="trash" size={16} />
                  </button>
                </>
              )}
              {open === p.id && (
                <div style={{ flexBasis: '100%' }}>
                  <ProfileContents profile={p} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && <ProfileEditor profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
      {deleting && (
        <Confirm
          title={t('Delete "{name}"?', { name: deleting.name })}
          body={<p>{t('Brews started with it keep their alerts and events.')}</p>}
          confirm={t('Delete')}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            brewApi.deleteProfile(deleting.id).then(reload, (e) => toast({ tone: 'error', title: t('Failed'), body: errorText(e) }))
          }
        />
      )}
    </section>
  );
}

const DAY_MS = 86_400_000;

/**
 * A profile's name, notes, alerts and planned events: a new one (`profile` null), or one to change. Its alerts are
 * edited as a brew's are, and its events on a day of the brew.
 */
function ProfileEditor({ profile, onClose, onSaved }: { profile: BrewProfile | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useLive();
  const u = useUnits();
  const [name, setName] = useState(profile?.name ?? '');
  const [notes, setNotes] = useState(profile?.notes ?? '');
  const [alerts, setAlerts] = useState<BrewAlertInput[]>(profile?.alerts ?? []);
  const [events, setEvents] = useState<ProfileEvent[]>(profile?.events ?? []);
  // index null: a new one.
  const [alertEditor, setAlertEditor] = useState<{ index: number | null; input: AlertRuleInput } | null>(null);
  const [eventEditor, setEventEditor] = useState<{ index: number | null; event: ProfileEvent | null } | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [busy, setBusy] = useState(false);
  // What a newer version saved in the profile is kept.
  const { id: _id, createdAt: _c, ...saved } = profile ?? { id: '', createdAt: 0 };
  const input = { ...saved, name: name.trim(), notes, alerts, events };
  const check = useFormCheck(brewProfileInputSchema, input, LABELS);
  useEffect(() => {
    if (alertEditor) channelApi.list().then(setChannels, () => undefined);
  }, [alertEditor]);

  const putAlert = (index: number | null, a: BrewAlertInput) =>
    setAlerts((cur) => (index === null ? [...cur, a] : cur.map((x, j) => (j === index ? a : x))));
  const putEvent = (index: number | null, e: ProfileEvent) =>
    setEvents((cur) => (index === null ? [...cur, e] : cur.map((x, j) => (j === index ? e : x))).sort((a, b) => a.offset - b.offset));

  return (
    <Modal title={profile ? t('Edit profile') : t('New profile')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!check.ok(t("Couldn't save"))) return;
          setBusy(true);
          try {
            const done = profile ? await brewApi.updateProfile(profile.id, input) : await brewApi.addProfile(input);
            if (!profile)
              toast({ tone: 'success', title: t('Saved "{name}"', { name: done.name }), body: t('Pick it when you start a brew.') });
            onSaved();
            onClose();
          } catch (err) {
            toast({ tone: 'error', title: t("Couldn't save"), body: errorText(err) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>{t('Name')}</span>
          <input
            className="input"
            required
            maxLength={80}
            value={name}
            placeholder="NEIPA"
            autoFocus={!profile}
            onChange={(e) => setName(e.target.value)}
          />
          <FieldError error={check.errors.name} />
        </label>
        <label className="field">
          <span>{t('Notes')}</span>
          <textarea
            className="textarea"
            rows={2}
            maxLength={2000}
            value={notes}
            placeholder={t('Yeast, hops, dry hop schedule…')}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="field">
          <span>{t('In it')}</span>
          {alerts.length === 0 && events.length === 0 && <p className="muted small">{t('Nothing in it yet.')}</p>}
          <div className="list">
            {alerts.map((a, i) => (
              <div key={`a${i}`} className="list-item">
                <Icon name="alert" size={14} />
                <div className="grow">
                  <h4>{a.name}</h4>
                  <p>
                    {describeAlert(a, u)}
                    {a.message ? ` · “${a.message}”` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn small icon ghost"
                  aria-label={t('Edit {name}', { name: a.name })}
                  onClick={() => setAlertEditor({ index: i, input: ruleInputOf(a) })}
                >
                  <Icon name="pencil" size={14} />
                </button>
                <button
                  type="button"
                  className="btn small icon ghost"
                  aria-label={t('Take out {name}', { name: a.name })}
                  onClick={() => setAlerts(alerts.filter((_, j) => j !== i))}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
            {events.map((ev, i) => {
              const label = ev.kind === 'note' ? t('Note') : t(eventKind(ev.kind).label);
              const what = `${brewDay(0, ev.offset)}: ${label}`;
              return (
                <div key={`e${i}`} className="list-item">
                  <Icon name="calendar" size={14} />
                  <div className="grow">
                    <h4>
                      {what}
                      {ev.endOffset !== null && <span className="muted small"> ({days(ev.endOffset - ev.offset)})</span>}
                    </h4>
                    {ev.text && <p>{ev.text}</p>}
                  </div>
                  <label className="check" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={ev.remind}
                      onChange={(e) => setEvents(events.map((x, j) => (j === i ? { ...x, remind: e.target.checked } : x)))}
                    />
                    <span>{t('Remind')}</span>
                  </label>
                  <button
                    type="button"
                    className="btn small icon ghost"
                    aria-label={t('Edit {name}', { name: what })}
                    onClick={() => setEventEditor({ index: i, event: ev })}
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn small icon ghost"
                    aria-label={t('Take out {name}', { name: what })}
                    onClick={() => setEvents(events.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="row">
            <button type="button" className="btn small" onClick={() => setAlertEditor({ index: null, input: newBrewAlert() })}>
              <Icon name="plus" size={14} /> {t('Add alert')}
            </button>
            <button type="button" className="btn small" onClick={() => setEventEditor({ index: null, event: null })}>
              <Icon name="plus" size={14} /> {t('Add event')}
            </button>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {profile ? t('Save') : t('Save profile')}
          </button>
        </div>
      </form>
      {/* Outside the form: a dialog's submit would otherwise reach this form through React too. */}
      {alertEditor && (
        <RuleModal
          brew={{ name: name.trim() || t('this profile') }}
          isNew={alertEditor.index === null}
          initial={alertEditor.input}
          channels={channels}
          onClose={() => setAlertEditor(null)}
          onSave={async (rule) => putAlert(alertEditor.index, brewInputOf(rule))}
        />
      )}
      {eventEditor && (
        <ProfileEventModal
          event={eventEditor.event}
          onClose={() => setEventEditor(null)}
          onSave={(ev) => putEvent(eventEditor.index, ev)}
        />
      )}
    </Modal>
  );
}

const EVENT_LABELS = { offset: tk('Day of the brew'), endOffset: tk('Lasts (days)'), kind: tk('What'), text: tk('Details') };

/** A profile's planned event: what, on which day of the brew, lasting a while if you like, and whether it reminds you. */
function ProfileEventModal({
  event,
  onClose,
  onSave,
}: {
  event: ProfileEvent | null;
  onClose: () => void;
  onSave: (e: ProfileEvent) => void;
}) {
  const { toast } = useLive();
  const firstDay = String(event ? Math.floor(event.offset / DAY_MS) + 1 : 3);
  const firstLasts = event?.endOffset != null ? String(Math.round(((event.endOffset - event.offset) / DAY_MS) * 100) / 100) : '';
  const [kind, setKind] = useState<BrewEventKind>(event?.kind ?? 'dry_hop');
  const [day, setDay] = useState(firstDay);
  const [lasts, setLasts] = useState(firstLasts);
  const [text, setText] = useState(event?.text ?? '');
  const [remind, setRemind] = useState(event?.remind ?? true);
  const [tried, setTried] = useState(false);
  const k = eventKind(kind);
  const dayN = Number(day);
  const dayOk = day.trim() !== '' && Number.isInteger(dayN) && dayN >= 1 && dayN <= 365;
  const lastsN = Number(lasts);
  const lastsOk = lasts.trim() === '' || (Number.isFinite(lastsN) && lastsN > 0 && lastsN <= 365);
  // An event's own times are kept unless they're changed (one saved from a brew can be part way through a day).
  const offset = event && day === firstDay ? event.offset : (dayN - 1) * DAY_MS;
  const endOffset =
    lasts.trim() === ''
      ? null
      : event?.endOffset != null && day === firstDay && lasts === firstLasts
        ? event.endOffset
        : offset + Math.round(lastsN * DAY_MS);
  const body: ProfileEvent = { offset, endOffset, kind, text: text.trim(), remind };
  const check = useFormCheck(profileEventSchema, body, EVENT_LABELS);

  return (
    <Modal title={event ? t('Edit planned event') : t('Plan an event')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!dayOk || !lastsOk) {
            const field = !dayOk ? t('Day of the brew') : t('Lasts (days)');
            toast({ tone: 'error', title: t("Couldn't save"), body: t('Check {fields}.', { fields: field }) });
            return;
          }
          if (!check.ok(t("Couldn't save"))) return;
          onSave(body);
          onClose();
        }}
      >
        <div className="field">
          <span>{t('What happened')}</span>
          <div className="kind-picker" role="radiogroup" aria-label={t('Kind of event')}>
            {EVENT_KINDS.map((o) => (
              <button
                key={o.kind}
                type="button"
                role="radio"
                aria-checked={kind === o.kind}
                className={kind === o.kind ? 'on' : ''}
                style={{ '--ev': o.color } as React.CSSProperties}
                onClick={() => setKind(o.kind)}
              >
                <Icon name={o.icon} size={18} />
                <span>{t(o.label)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>{t('Day of the brew')}</span>
            <input className="input num" type="number" min={1} max={365} step={1} value={day} onChange={(e) => setDay(e.target.value)} />
            <FieldError error={tried && !dayOk ? tk('Use a whole number from 1 to 365') : undefined} />
            <span className="hint">{t('Day 1 is its first 24 hours.')}</span>
          </label>
          <label className="field">
            <span>{t('Lasts (days, optional)')}</span>
            <input
              className="input num"
              type="number"
              min={0}
              step="any"
              value={lasts}
              placeholder="3"
              onChange={(e) => setLasts(e.target.value)}
            />
            <FieldError error={tried && !lastsOk ? tk('More than 0 days, and up to 365') : check.errors.endOffset} />
            <span className="hint">{t('For something that sits a while, like a dry hop.')}</span>
          </label>
        </div>
        <label className="field">
          <span>{kind === 'note' ? t('Note') : t('Details (optional)')}</span>
          <textarea
            className="textarea"
            rows={2}
            maxLength={500}
            value={text}
            placeholder={t(k.placeholder)}
            onChange={(e) => setText(e.target.value)}
          />
          <FieldError error={check.errors.text} />
        </label>
        <label className="check">
          <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
          <span>
            {t('Remind me at its start and end')}
            <small>{t('In a brew started with it, each one notifies you when its time comes.')}</small>
          </span>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary">
            {event ? t('Save') : t('Add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
