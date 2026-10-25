import { useEffect, useState } from 'react';
import type { HubWarning } from '@rapthooker/shared';
import { api, errorText } from '../api';
import { useLive } from '../live';
import { readStored, useStored, writeStored } from '../storage';
import { bannerWarnings, DISMISSED_WARNINGS_KEY, parseDismissed, pruneDismissed, serializeDismissed, warningKey } from '../warnings';
import { Icon } from './Icon';
import { t } from '../i18n';

const POLL_MS = 60_000;

/** Problems the hub reports (full disk, Bluetooth trouble...), as a slim banner under the top bar. */
export function HubWarnings() {
  const { connection } = useLive();
  const [warnings, setWarnings] = useState<HubWarning[]>([]);
  const [dismissed, setDismissed] = useStored(DISMISSED_WARNINGS_KEY, parseDismissed, serializeDismissed);

  // Checked every minute while connected, and straight after reconnecting.
  useEffect(() => {
    if (connection !== 'open') return;
    let stopped = false;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      api.status().then(
        (s) => {
          if (stopped) return;
          const list = Array.isArray(s.warnings) ? s.warnings : [];
          setWarnings(list);
          const saved = parseDismissed(readStored(DISMISSED_WARNINGS_KEY));
          const kept = pruneDismissed(saved, list);
          if (kept.length !== saved.length) writeStored(DISMISSED_WARNINGS_KEY, serializeDismissed(kept));
        },
        (err: unknown) => console.warn('hub status', errorText(err)),
      );
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [connection]);

  const shown = bannerWarnings(warnings, dismissed);
  if (shown.length === 0) return null;
  return (
    <div className="hub-warnings" role="region" aria-label={t('Hub warnings')}>
      {shown.map((w) => (
        <div key={warningKey(w)} className={`hub-warning ${w.level}`}>
          <Icon name="alert" size={16} />
          <p>{w.message}</p>
          <a href="#/settings" className="hub-warning-link">
            {t('Settings')}
          </a>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('Dismiss this warning')}
            title={t('Dismiss')}
            onClick={() => setDismissed([...dismissed, warningKey(w)])}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
