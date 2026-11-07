import { useEffect, useState } from 'react';
import type { AlertEvent } from '@rapthooker/shared';
import { api } from '../api';
import { useLiveMessages } from '../live';
import { parseFlag, serializeFlag, useStored } from '../storage';
import { t } from '../i18n';
import { Icon } from './Icon';

const SHOW_KEY = 'rapthooker.chart.alerts';
const NONE: AlertEvent[] = [];

/** On unless turned off. */
const parseShown = (raw: string | null): boolean => raw === null || parseFlag(raw);

/** Whether charts mark when alerts went off and cleared (on unless turned off in this browser). */
export function useShowAlerts(): [boolean, (on: boolean) => void] {
  return useStored(SHOW_KEY, parseShown, serializeFlag);
}

/**
 * A device's alert events, newest first, kept up to date as alerts go off (the hub keeps the latest 500 of all its
 * devices'). Nothing is fetched while `pillId` is null.
 */
export function useAlertEvents(pillId: string | null): AlertEvent[] {
  const [loaded, setLoaded] = useState<{ pillId: string; events: AlertEvent[] } | null>(null);
  // Bumped when the live connection (re)opens, as alerts may have gone off while it was down.
  const [connected, setConnected] = useState(0);
  useEffect(() => {
    if (!pillId) return;
    let stale = false;
    api.alertEvents(500, pillId).then(
      (events) => {
        if (!stale) setLoaded({ pillId, events });
      },
      // Only the marks on the chart are missing: the chart itself still works.
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [pillId, connected]);
  useLiveMessages((m) => {
    if (m.type === 'hello') setConnected((n) => n + 1);
    else if (m.type === 'alert' && m.event.pillId === pillId)
      setLoaded((l) =>
        l && l.pillId === m.event.pillId ? { ...l, events: [m.event, ...l.events.filter((e) => e.id !== m.event.id)] } : l,
      );
  });
  return loaded && loaded.pillId === pillId ? loaded.events : NONE;
}

/** The chart option that marks when alerts went off and cleared. */
export function AlertsToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`chip${on ? ' on' : ''}`}
      aria-pressed={on}
      title={on ? t('When alerts went off and cleared is marked on the chart.') : t('Turn on to mark when alerts went off and cleared.')}
      onClick={() => onChange(!on)}
    >
      <Icon name="alert" size={12} /> {t('Alerts')}
    </button>
  );
}
