import { useState } from 'react';
import type { ScreenDevice, ScreenState } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { navigate } from '../../router';
import { timeAgo, useNow } from '../../format';
import { t } from '../../i18n';
import { Icon } from '../../components/Icon';
import { SignalBars } from '../../components/ui';
import { screensApi } from './screensApi';
import { everyText, ScreenEditor } from './ScreenEditor';
import { STATE_LABELS } from './strings';
import './screens.css';

const STATE_CHIP: Record<ScreenState, string> = { online: 'success', late: 'warning', offline: 'danger', unknown: '' };

/** Changes whenever the screen's picture would: a new one fetched, or a new look. */
const pictureVersion = (s: ScreenDevice) => {
  const text = `${s.status.lastSeenAt ?? 0}|${s.pillId}|${JSON.stringify(s.look)}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** The picture the screen shows, as the hub draws it for the screen. */
export function ScreenThumb({ screen }: { screen: ScreenDevice }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`screen-thumb ${screen.status.state}`}>
      {failed ? (
        <Icon name="screen" size={36} />
      ) : (
        <img
          src={screensApi.pictureUrl(screen.id, pictureVersion(screen))}
          alt={t('What {name} shows', { name: screen.name })}
          width={240}
          height={240}
          loading="lazy"
          onError={() => setFailed(true)}
          onLoad={() => setFailed(false)}
        />
      )}
    </div>
  );
}

export function ScreenStateChip({ screen }: { screen: ScreenDevice }) {
  const s = screen.status;
  if (s.updating) {
    return (
      <span className="chip warning">
        <Icon name="download" size={12} /> {t('Updating…')}
      </span>
    );
  }
  return <span className={`chip ${STATE_CHIP[s.state]}`}>{t(STATE_LABELS[s.state])}</span>;
}

export function ScreenCard({ screen }: { screen: ScreenDevice }) {
  const { pills, isOwner, toast, upsertScreen } = useLive();
  const now = useNow(15_000);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = screen.status;
  const shows = screen.pillId === null ? t('All pills') : (pills.find((p) => p.id === screen.pillId)?.name ?? t('A removed pill'));

  const identify = async () => {
    try {
      await screensApi.action(screen.id, 'identify');
      toast({ tone: 'info', title: t('{name} is showing its name', { name: screen.name }) });
    } catch (err) {
      toast({ tone: 'error', title: t("The screen didn't answer"), body: errorText(err) });
    }
  };
  const update = async () => {
    setBusy(true);
    try {
      upsertScreen(await screensApi.update(screen.id));
      toast({ tone: 'success', title: t('{name} is up to date', { name: screen.name }) });
    } catch (err) {
      toast({ tone: 'error', title: t("Couldn't update the screen"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`panel screen-card ${s.state}`}>
      {isOwner ? (
        <button
          type="button"
          className="screen-thumb-btn"
          onClick={() => setEditing(true)}
          aria-label={t('Edit {name}', { name: screen.name })}
        >
          <ScreenThumb screen={screen} />
        </button>
      ) : (
        <ScreenThumb screen={screen} />
      )}
      <div className="screen-card-body">
        <div className="row screen-card-title">
          <h3>{screen.name}</h3>
          <ScreenStateChip screen={screen} />
        </div>
        <p className="small muted">
          <Icon name="droplet" size={12} /> {shows} · {t('every {interval}', { interval: everyText(screen.interval) })}
        </p>
        <p className="small muted screen-card-seen">
          {s.lastSeenAt ? t('Last picture {ago}', { ago: timeAgo(s.lastSeenAt, now) }) : t('No picture fetched since the hub started')}
          {s.rssi !== null && <SignalBars rssi={s.rssi} />}
        </p>
        {s.error === 'not-allowed' && (
          <p className="small screen-card-problem">
            <Icon name="alert" size={12} /> {t('The screen no longer accepts this hub (it was reset or set up again).')}
          </p>
        )}
        {s.update && !s.updating && (
          <p className="small screen-card-update">
            <Icon name="sparkles" size={12} />{' '}
            {t('Firmware {version} is available (it has {current})', { version: s.update, current: screen.firmware ?? '?' })}
          </p>
        )}
        {isOwner && (
          <div className="row screen-card-actions">
            <button type="button" className="btn small" onClick={() => setEditing(true)}>
              <Icon name="pencil" size={14} /> {t('Edit')}
            </button>
            <button
              type="button"
              className="btn small ghost"
              onClick={() => void identify()}
              title={t('The screen shows its name for a moment')}
            >
              <Icon name="screen" size={14} /> {t('Show its name')}
            </button>
            {s.update && (
              <button type="button" className="btn small primary" disabled={busy || s.updating} onClick={() => void update()}>
                <Icon name="download" size={14} /> {t('Update')}
              </button>
            )}
          </div>
        )}
      </div>
      {editing && <ScreenEditor screen={screen} onClose={() => setEditing(false)} />}
    </article>
  );
}

/**
 * The screens showing `pillId` (null: the ones showing every pill), as chips that open the screen's settings, for the
 * pages where the picture's subject is.
 */
export function ScreenChips({ pillId }: { pillId: string | null }) {
  const { screens, isOwner } = useLive();
  const [editing, setEditing] = useState<string | null>(null);
  const tied = screens.filter((s) => s.pillId === pillId);
  const open = tied.find((s) => s.id === editing);
  if (tied.length === 0) return null;
  return (
    <>
      {tied.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`chip screen-chip ${s.status.state}`}
          title={t('Shown on {name} ({state})', { name: s.name, state: t(STATE_LABELS[s.status.state]) })}
          onClick={() => (isOwner ? setEditing(s.id) : navigate('#/screens'))}
        >
          <Icon name="screen" size={13} /> {s.name}
          <span className={`status-dot${s.status.state === 'online' ? ' on' : ''}`} aria-hidden="true" />
        </button>
      ))}
      {open && <ScreenEditor screen={open} onClose={() => setEditing(null)} />}
    </>
  );
}

/** A small mark on a pill's card when a screen shows it. */
export function ScreenMark({ pillId }: { pillId: string }) {
  const { screens } = useLive();
  const tied = screens.filter((s) => s.pillId === pillId);
  if (tied.length === 0) return null;
  const names = tied.map((s) => s.name).join(', ');
  return (
    <span className="chip screen-mark" title={t('Shown on {name}', { name: names })}>
      <Icon name="screen" size={12} />
      <span className="sr-only">{t('Shown on {name}', { name: names })}</span>
    </span>
  );
}
