import type { Webhook } from '@rapthooker/shared';
import { http } from '../../api';
import { intlLocale } from '../../format';
import { t } from '../../i18n';

const enc = encodeURIComponent;

/** Webhook calls beyond the basic ones in api.ts. */
export const webhookApi = {
  pause: (id: string, until: number | null) => http.post<Webhook>(`/api/webhooks/${enc(id)}/pause`, { until }),
  duplicate: (id: string) => http.post<Webhook>(`/api/webhooks/${enc(id)}/duplicate`),
  import: (file: unknown) => http.post<Webhook[]>('/api/webhooks/import', file),
  exportUrl: '/api/webhooks/export',
};

/** A pause "until I resume": far enough ahead never to end by itself. */
export const PAUSE_UNTIL_RESUMED = Date.UTC(9999, 11, 31);

export const isPausedNow = (hook: Pick<Webhook, 'pausedUntil'>, now = Date.now()): boolean =>
  hook.pausedUntil !== null && hook.pausedUntil > now;

export function pausedText(until: number, now = Date.now()): string {
  if (until - now > 365 * 86_400_000) return t('Paused until you resume it');
  const sameDay = new Date(until).toDateString() === new Date(now).toDateString();
  const time = new Date(until).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return t('Paused until {time}', { time });
  const date = new Date(until).toLocaleDateString(intlLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
  return t('Paused until {date} {time}', { date, time });
}
