import { useId, useState } from 'react';
import { brewEventInputSchema, type Brew, type BrewEvent, type BrewEventKind } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { fromLocalInput, toLocalInput } from '../../format';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { FieldError, useFormCheck } from '../../validation';
import { currentLocale, t, tk, tp } from '../../i18n';
import { brewApi } from './api';
import { brewDay, EVENT_KINDS, eventKind, eventTime } from './brewText';
import './brews.css';

export { brewDay, EVENT_KINDS, eventKind } from './brewText';

export function EventIcon({ kind, size = 15 }: { kind: BrewEventKind; size?: number }) {
  const k = eventKind(kind);
  return (
    <span className="ev-icon" style={{ '--ev': k.color } as React.CSSProperties} title={t(k.label)}>
      <Icon name={k.icon} size={size} />
    </span>
  );
}

/** A brew's events, oldest first, as a timeline. */
export function EventList({
  brew,
  events = brew.events,
  onEdit,
  onToggleChart,
  toggling,
  compact = false,
}: {
  brew: Pick<Brew, 'startedAt' | 'events'>;
  events?: BrewEvent[];
  onEdit?: (e: BrewEvent) => void;
  /** Shows or hides an event on the charts. */
  onToggleChart?: (e: BrewEvent) => void;
  /** The event being shown or hidden. */
  toggling?: string | null;
  compact?: boolean;
}) {
  if (events.length === 0) return null;
  const now = Date.now();
  return (
    <ol className={`brew-timeline${compact ? ' compact' : ''}`}>
      {events.map((e) => {
        const k = eventKind(e.kind);
        const name = t(k.label).toLocaleLowerCase(currentLocale());
        const toggle = e.hidden ? t('Show {event} on the chart', { event: name }) : t('Hide {event} from the chart', { event: name });
        const planned = e.at > now;
        return (
          <li key={e.id} className={[e.hidden ? 'off-chart' : '', planned ? 'planned' : ''].filter(Boolean).join(' ') || undefined}>
            <EventIcon kind={e.kind} />
            <div className="grow">
              <div className="ev-title">
                <strong>{e.kind === 'note' ? t('Note') : t(k.label)}</strong>
                {e.text && <span>{e.text}</span>}
              </div>
              <div className="ev-when">
                {brewDay(brew.startedAt, e.at)} · {eventTime(e)}
                {planned && <> · {t('Planned')}</>}
                {e.alertId && <> · {t('From an alert')}</>}
                {e.remind && (
                  <span className="ev-remind" title={t('Reminds you at its start and end')}>
                    {' '}
                    · <Icon name="bell" size={12} /> {t('Reminder')}
                  </span>
                )}
                {e.hidden && <> · {t('Not on the chart')}</>}
              </div>
            </div>
            {onToggleChart && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => onToggleChart(e)}
                disabled={toggling === e.id}
                aria-label={toggle}
                title={toggle}
              >
                <Icon name={e.hidden ? 'eyeOff' : 'eye'} size={15} />
              </button>
            )}
            {onEdit && (
              <button type="button" className="icon-btn" onClick={() => onEdit(e)} aria-label={t('Edit {event}', { event: name })}>
                <Icon name="pencil" size={15} />
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The timeline with an "Add" button and its editor, for the brew and pill pages. */
export function EventsSection({
  brew,
  limit,
  onChanged,
}: {
  brew: Brew;
  /** Show only the latest few, with a link to the rest. */
  limit?: number;
  onChanged?: () => void;
}) {
  const { isOwner, toast } = useLive();
  const [editing, setEditing] = useState<BrewEvent | 'new' | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const shown = limit ? brew.events.slice(-limit) : brew.events;
  const hidden = brew.events.length - shown.length;

  // Leaving the end out keeps it as it is (and times that don't change aren't checked again).
  const toggleChart = async (e: BrewEvent) => {
    if (toggling) return;
    setToggling(e.id);
    try {
      await brewApi.updateEvent(brew.id, e.id, { at: e.at, kind: e.kind, text: e.text, hidden: !e.hidden });
      onChanged?.();
    } catch (err) {
      toast({ tone: 'error', title: e.hidden ? t("Couldn't show the event") : t("Couldn't hide the event"), body: errorText(err) });
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className="stack" style={{ gap: '0.6rem' }}>
      <div className="row">
        <h3 className="spacer ev-head">
          <Icon name="list" size={16} /> {t('Timeline')}
        </h3>
        {isOwner && (
          <button type="button" className="btn small" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('Add event')}
          </button>
        )}
      </div>
      {brew.events.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          {brew.endedAt === null
            ? t(
                'Dry hops, temperature changes, cold crashes, additions and notes show up here and on the chart. Plan one ahead to be reminded when its time comes.',
              )
            : t('Dry hops, temperature changes, cold crashes, additions and notes show up here and on the chart.')}
        </p>
      ) : (
        <>
          {hidden > 0 && (
            <p className="muted small" style={{ margin: 0 }}>
              {tp(hidden, "{count} earlier event on the brew's page.", "{count} earlier events on the brew's page.")}
            </p>
          )}
          <EventList
            brew={brew}
            events={shown}
            compact={limit !== undefined}
            onEdit={isOwner ? setEditing : undefined}
            onToggleChart={isOwner ? (e) => void toggleChart(e) : undefined}
            toggling={toggling}
          />
        </>
      )}
      {editing && (
        <EventModal brew={brew} event={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={onChanged} />
      )}
    </div>
  );
}

const LABELS = { at: tk('When'), endAt: tk('Until'), kind: tk('What'), text: tk('Details') };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function EventModal({
  brew,
  event,
  onClose,
  onSaved,
}: {
  brew: Brew;
  event: BrewEvent | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { toast } = useLive();
  const untilId = useId();
  const running = brew.endedAt === null;
  const [kind, setKind] = useState<BrewEventKind>(event?.kind ?? 'dry_hop');
  const [opened] = useState(() => toLocalInput(event?.at ?? Math.min(Date.now(), brew.endedAt ?? Date.now())));
  const [when, setWhen] = useState(opened);
  const [openedUntil] = useState(() => (event?.endAt != null ? toLocalInput(event.endAt) : null));
  const [until, setUntil] = useState(openedUntil);
  const [text, setText] = useState(event?.text ?? '');
  const [remind, setRemind] = useState(event?.remind ?? false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The boxes show times to the minute: keep an event's own times unless they're changed.
  const at = event && when === opened ? event.at : fromLocalInput(when);
  const endAt = until === null ? null : event?.endAt != null && until === openedUntil ? event.endAt : fromLocalInput(until);
  // Only a running brew's events can remind: left out, it stays as it was.
  const body = { at, endAt, kind, text: text.trim(), ...(running ? { remind } : {}) };
  const check = useFormCheck(brewEventInputSchema, body, LABELS);
  const endFirst = endAt !== null && endAt <= at;
  const k = eventKind(kind);
  const now = Date.now();
  const ahead = running && ((Number.isFinite(at) && at > now) || (endAt !== null && Number.isFinite(endAt) && endAt > now));

  // Something over is usually logged once it's done (it ended now); one that has only just begun gets a planned end, a day on.
  const startUntil = () => {
    const start = fromLocalInput(when);
    const now = Math.min(Date.now(), brew.endedAt ?? Date.now());
    setUntil(toLocalInput(Number.isFinite(start) && now < start + HOUR ? start + DAY : now));
  };

  /** Runs `fn`, then closes; on failure shows `failed` as the error's title. */
  const run = async (failed: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onSaved?.();
      onClose();
    } catch (err) {
      toast({ tone: 'error', title: failed, body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={event ? t('Edit event') : t('Add an event')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (kind === 'note' && !body.text) {
            toast({ tone: 'error', title: t("Couldn't save"), body: t('Write something for the note.') });
            return;
          }
          if (!check.ok(t("Couldn't save"))) return;
          if (endFirst) {
            toast({ tone: 'error', title: t("Couldn't save"), body: t('The end has to be after the start.') });
            return;
          }
          void run(t("Couldn't save the event"), () =>
            event ? brewApi.updateEvent(brew.id, event.id, body) : brewApi.addEvent(brew.id, body),
          );
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
        <label className="field">
          <span>{t('When')}</span>
          <input
            className="input"
            type="datetime-local"
            value={when}
            max={running ? undefined : toLocalInput(Date.now())}
            onChange={(e) => setWhen(e.target.value)}
          />
          <FieldError error={check.errors.at && tk('Pick a date and time')} />
          {running && Number.isFinite(at) && at > now && (
            <span className="hint">{t('Planned: it goes on the chart when its time comes.')}</span>
          )}
        </label>
        {until === null ? (
          <div>
            <button type="button" className="btn small ghost" onClick={startUntil}>
              <Icon name="plus" size={14} /> {t('Add an end time')}
            </button>
          </div>
        ) : (
          <div className="field">
            <label className="label" htmlFor={untilId}>
              {t('Until')}
            </label>
            <div className="row ev-until">
              <input
                id={untilId}
                className="input"
                type="datetime-local"
                value={until}
                min={when}
                onChange={(e) => setUntil(e.target.value)}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={t('Remove the end')}
                title={t('Remove the end')}
                onClick={() => setUntil(null)}
              >
                <Icon name="x" size={15} />
              </button>
            </div>
            <FieldError
              error={(check.errors.endAt && tk('Pick a date and time')) || (tried && endFirst && tk('The end has to be after the start'))}
            />
            <span className="hint">{t('The chart shades the time in between.')}</span>
          </div>
        )}
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
        {running && (
          <label className="check">
            <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
            <span>
              {t('Remind me at its start and end')}
              <small>
                {ahead || remind
                  ? t('Sent everywhere alerts go, at a time still to come.')
                  : t('Pick a time still to come to be reminded of it.')}
              </small>
            </span>
          </label>
        )}
        <div className="modal-actions">
          {event &&
            (confirmDelete ? (
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() => void run(t("Couldn't delete the event"), () => brewApi.deleteEvent(brew.id, event.id))}
              >
                <Icon name="trash" size={14} /> {t('Really delete')}
              </button>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" size={14} /> {t('Delete')}
              </button>
            ))}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {event ? t('Save') : t('Add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
