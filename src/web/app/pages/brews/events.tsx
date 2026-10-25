import { useState } from 'react';
import { brewEventInputSchema, type Brew, type BrewEvent, type BrewEventKind } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { dateTime, fromLocalInput, toLocalInput } from '../../format';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { FieldError, useFormCheck } from '../../validation';
import { currentLocale, t, tk, tp } from '../../i18n';
import { brewApi } from './api';
import { brewDay, EVENT_KINDS, eventKind } from './brewText';
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
  compact = false,
}: {
  brew: Pick<Brew, 'startedAt' | 'events'>;
  events?: BrewEvent[];
  onEdit?: (e: BrewEvent) => void;
  compact?: boolean;
}) {
  if (events.length === 0) return null;
  return (
    <ol className={`brew-timeline${compact ? ' compact' : ''}`}>
      {events.map((e) => {
        const k = eventKind(e.kind);
        return (
          <li key={e.id}>
            <EventIcon kind={e.kind} />
            <div className="grow">
              <div className="ev-title">
                <strong>{e.kind === 'note' ? t('Note') : t(k.label)}</strong>
                {e.text && <span>{e.text}</span>}
              </div>
              <div className="ev-when">
                {brewDay(brew.startedAt, e.at)} · {dateTime(e.at)}
              </div>
            </div>
            {onEdit && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => onEdit(e)}
                aria-label={t('Edit {event}', { event: t(k.label).toLocaleLowerCase(currentLocale()) })}
              >
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
  const { isOwner } = useLive();
  const [editing, setEditing] = useState<BrewEvent | 'new' | null>(null);
  const shown = limit ? brew.events.slice(-limit) : brew.events;
  const hidden = brew.events.length - shown.length;

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
          {t('Dry hops, temperature changes, cold crashes, additions and notes show up here and on the chart.')}
        </p>
      ) : (
        <>
          {hidden > 0 && (
            <p className="muted small" style={{ margin: 0 }}>
              {tp(hidden, "{count} earlier event on the brew's page.", "{count} earlier events on the brew's page.")}
            </p>
          )}
          <EventList brew={brew} events={shown} compact={limit !== undefined} onEdit={isOwner ? setEditing : undefined} />
        </>
      )}
      {editing && (
        <EventModal brew={brew} event={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={onChanged} />
      )}
    </div>
  );
}

const LABELS = { at: tk('When'), kind: tk('What'), text: tk('Details') };

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
  const [kind, setKind] = useState<BrewEventKind>(event?.kind ?? 'dry_hop');
  const [opened] = useState(() => toLocalInput(event?.at ?? Math.min(Date.now(), brew.endedAt ?? Date.now())));
  const [when, setWhen] = useState(opened);
  const [text, setText] = useState(event?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The box shows the time to the minute: keep an event's own time unless it's changed.
  const body = { at: event && when === opened ? event.at : fromLocalInput(when), kind, text: text.trim() };
  const check = useFormCheck(brewEventInputSchema, body, LABELS);
  const k = eventKind(kind);

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
          if (kind === 'note' && !body.text) {
            toast({ tone: 'error', title: t("Couldn't save"), body: t('Write something for the note.') });
            return;
          }
          if (!check.ok(t("Couldn't save"))) return;
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
            max={toLocalInput(Date.now())}
            onChange={(e) => setWhen(e.target.value)}
          />
          <FieldError error={check.errors.at && tk('Pick a date and time')} />
        </label>
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
