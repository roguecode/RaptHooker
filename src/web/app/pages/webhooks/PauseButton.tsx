import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Webhook } from '@rapthooker/shared';
import { errorText } from '../../api';
import { useLive } from '../../live';
import { useNow } from '../../format';
import { t, tk } from '../../i18n';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { isPausedNow, PAUSE_UNTIL_RESUMED, webhookApi } from './webhookApi';

const CHOICES = [
  { label: tk('For 1 hour'), ms: 3_600_000 },
  { label: tk('For 1 day'), ms: 86_400_000 },
  { label: tk('Until I resume it'), ms: null },
] as const;

/** "Pause" (for an hour, a day or until resumed) or "Resume" when it's paused. */
export function PauseButton({ hook, onChange }: { hook: Pick<Webhook, 'id' | 'name' | 'pausedUntil'>; onChange: (hook: Webhook) => void }) {
  const { toast } = useLive();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (until: number | null) => {
    setBusy(true);
    try {
      onChange(await webhookApi.pause(hook.id, until));
      setOpen(false);
      toast({
        tone: 'success',
        title: until === null ? t('Resumed') : t('Paused'),
        body: until === null ? t('It sends on its schedule again.') : undefined,
      });
    } catch (err) {
      toast({ tone: 'error', title: until === null ? t("Couldn't resume") : t("Couldn't pause"), body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  if (isPausedNow(hook, now)) {
    return (
      <button type="button" className="btn small" disabled={busy} onClick={() => void run(null)}>
        <Icon name="play" size={14} /> {t('Resume')}
      </button>
    );
  }
  return (
    <>
      <button type="button" className="btn small ghost" onClick={() => setOpen(true)}>
        <Icon name="pause" size={14} /> {t('Pause')}
      </button>
      {open &&
        // In a portal: a card's styles would otherwise trap the modal's backdrop inside the card.
        createPortal(
          <Modal title={t('Pause "{name}"?', { name: hook.name })} onClose={() => setOpen(false)}>
            <p className="muted">
              {t("Nothing is sent while it's paused; your pills are still recorded. It carries on by itself when the pause is over.")}
            </p>
            <div className="modal-actions">
              {CHOICES.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className={`btn${c.ms === null ? ' primary' : ''}`}
                  disabled={busy}
                  onClick={() => void run(c.ms === null ? PAUSE_UNTIL_RESUMED : Date.now() + c.ms)}
                >
                  {t(c.label)}
                </button>
              ))}
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
