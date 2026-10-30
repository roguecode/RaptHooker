import type {
  AlertEvent,
  AlertRule,
  AlertRuleInput,
  Brew,
  BrewInput,
  History,
  HubSettings,
  HubStatus,
  NearbyPill,
  Pill,
  PillPatchBody,
  Session,
  Webhook,
  WebhookDelivery,
  WebhookInput,
  BleStatus,
  GravityUnit,
  TemperatureUnit,
} from '@rapthooker/shared';
import { t } from './i18n';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    // Offline, or the hub is restarting.
    throw new ApiError(t("Can't reach the hub. Check the connection and try again."), 0);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    // Not from the hub (a proxy or captive portal page, say).
    throw new ApiError(res.ok ? t("The hub sent an answer this page can't read") : `${res.status} ${res.statusText}`, res.status);
  }
  if (!res.ok) throw new ApiError((data as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body: unknown = {}) => request<T>('POST', url, body);

/** Plain JSON requests, for feature modules that keep their own API calls next to their components. */
export const http = {
  get,
  post,
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T = void>(url: string) => request<T>('DELETE', url),
};

export interface Settings {
  units: { temperature: TemperatureUnit; gravity: GravityUnit };
  ignored: string[];
}

export const api = {
  session: () => get<Session>('/api/session'),
  login: (pin: string) => post<Session>('/api/login', { pin }),
  logout: () => post<Session>('/api/logout'),
  setPin: (pin: string, currentPin?: string) => post<Session>('/api/owner-pin', { pin, currentPin }),

  state: () => get<{ pills: Pill[]; nearby: NearbyPill[]; ble: BleStatus; clockSynced: boolean }>('/api/state'),
  adopt: (address: string, name?: string) => post<Pill>('/api/pills', { address, name }),
  updatePill: (id: string, patch: PillPatchBody) => request<Pill>('PATCH', `/api/pills/${encodeURIComponent(id)}`, patch),
  reorderPills: (ids: string[]) => post<void>('/api/pills/order', { ids }),
  deletePill: (id: string) => request<void>('DELETE', `/api/pills/${encodeURIComponent(id)}`),
  addExclusion: (id: string, range: { from: number; to: number }) =>
    post<Pill>(`/api/pills/${encodeURIComponent(id)}/exclusions`, { from: Math.round(range.from), to: Math.round(range.to) }),
  removeExclusion: (id: string, exclusionId: string) =>
    request<Pill>('DELETE', `/api/pills/${encodeURIComponent(id)}/exclusions/${encodeURIComponent(exclusionId)}`),
  ignoreNearby: (address: string, ignored: boolean) => post<{ ignored: string[] }>('/api/nearby/ignore', { address, ignored }),
  history: (id: string, from: number, to: number, points = 800, exclude = false) =>
    get<History>(
      `/api/pills/${encodeURIComponent(id)}/history?from=${Math.floor(from)}&to=${Math.ceil(to)}&points=${points}${exclude ? '&exclude=1' : ''}`,
    ),
  pillCsvUrl: (id: string) => `/api/pills/${encodeURIComponent(id)}/export.csv`,

  brews: (pillId?: string) => get<Brew[]>(`/api/brews${pillId ? `?pill=${encodeURIComponent(pillId)}` : ''}`),
  brew: (id: string) => get<Brew>(`/api/brews/${encodeURIComponent(id)}`),
  startBrew: (pillId: string, input: Partial<BrewInput> & { startedAt?: number }) => post<Brew>('/api/brews', { pillId, ...input }),
  updateBrew: (id: string, patch: Partial<BrewInput> & { startedAt?: number; endedAt?: number | null }) =>
    request<Brew>('PATCH', `/api/brews/${encodeURIComponent(id)}`, patch),
  endBrew: (id: string) => post<Brew>(`/api/brews/${encodeURIComponent(id)}/end`),
  deleteBrew: (id: string) => request<void>('DELETE', `/api/brews/${encodeURIComponent(id)}`),
  brewCsvUrl: (id: string) => `/api/brews/${encodeURIComponent(id)}/export.csv`,

  webhooks: () => get<Webhook[]>('/api/webhooks'),
  createWebhook: (input: WebhookInput) => post<Webhook>('/api/webhooks', input),
  updateWebhook: (id: string, input: WebhookInput) => request<Webhook>('PUT', `/api/webhooks/${encodeURIComponent(id)}`, input),
  setWebhookEnabled: (id: string, enabled: boolean) => post<Webhook>(`/api/webhooks/${encodeURIComponent(id)}/enabled`, { enabled }),
  deleteWebhook: (id: string) => request<void>('DELETE', `/api/webhooks/${encodeURIComponent(id)}`),
  deliveries: (id: string) => get<WebhookDelivery[]>(`/api/webhooks/${encodeURIComponent(id)}/deliveries`),
  testWebhook: (webhook: WebhookInput, webhookId: string | null, pillId: string | null) =>
    post<WebhookDelivery>('/api/webhooks/test', { webhook, webhookId, pillId }),

  alertRules: () => get<AlertRule[]>('/api/alerts/rules'),
  createAlert: (input: AlertRuleInput) => post<AlertRule>('/api/alerts/rules', input),
  updateAlert: (id: string, input: AlertRuleInput) => request<AlertRule>('PUT', `/api/alerts/rules/${encodeURIComponent(id)}`, input),
  deleteAlert: (id: string) => request<void>('DELETE', `/api/alerts/rules/${encodeURIComponent(id)}`),
  alertEvents: (limit = 30) => get<AlertEvent[]>(`/api/alerts/events?limit=${limit}`),

  pushKey: () => get<{ publicKey: string }>('/api/push/key'),
  pushSubscribe: (sub: PushSubscriptionJSON) => post<void>('/api/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => post<void>('/api/push/unsubscribe', { endpoint }),
  pushTest: () => post<void>('/api/push/test'),

  settings: () => get<Settings>('/api/settings'),
  saveSettings: (units: Settings['units']) => request<Settings>('PUT', '/api/settings', { units }),
  hub: () => get<HubSettings>('/api/settings/hub'),
  saveHub: (hub: HubSettings) => request<HubSettings>('PUT', '/api/settings/hub', hub),
  status: () => get<HubStatus>('/api/status'),
};

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
