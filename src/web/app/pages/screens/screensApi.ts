import type {
  FoundScreen,
  ScreenDevice,
  ScreenLook,
  ScreenManualStart,
  ScreenPatch,
  ScreenSetupProgress,
  WifiNetwork,
  WifiStatus,
} from '@rapthooker/shared';
import { ApiError, http } from '../../api';
import { t } from '../../i18n';

const one = (id: string) => `/api/screens/${encodeURIComponent(id)}`;

/** Sends raw bytes or reads text, which http (JSON only) doesn't. */
async function raw(method: string, url: string, body?: Blob): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/octet-stream' } : undefined,
      body,
    });
  } catch {
    throw new ApiError(t("Can't reach the hub. Check the connection and try again."), 0);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {}
    throw new ApiError(message, res.status);
  }
  return text;
}

export const screensApi = {
  list: () => http.get<ScreenDevice[]>('/api/screens'),
  wifi: () => http.get<WifiStatus>('/api/screens/wifi'),
  scan: () => http.post<WifiNetwork[]>('/api/screens/wifi/scan'),
  setup: () => http.get<ScreenSetupProgress | null>('/api/screens/setup'),
  startSetup: (input: {
    hotspot: string;
    ssid: string;
    password: string;
    name: string;
    pillId: string | null;
    look: Partial<ScreenLook>;
  }) => http.post<ScreenSetupProgress>('/api/screens/setup', input),
  found: () => http.get<FoundScreen[]>('/api/screens/found'),
  discover: () => http.post<FoundScreen[]>('/api/screens/discover'),
  adopt: (input: { id: string; code?: string; name?: string; look?: Partial<ScreenLook> }) =>
    http.post<{ screen: ScreenDevice | null; needsCode: boolean }>('/api/screens/adopt', input),
  manual: (input: { name: string; pillId: string | null; look: Partial<ScreenLook> }) =>
    http.post<ScreenManualStart>('/api/screens/manual', input),
  manualDone: (input: { pending: string; id: string; model: string; ip: string | null }) =>
    http.post<ScreenDevice>('/api/screens/manual/done', input),
  firmwareUrl: (model: string) => `/api/screens/firmware/${encodeURIComponent(model)}`,
  updateAll: () => http.post<{ updated: string[]; failed: string[] }>('/api/screens/update-all'),
  patch: (id: string, patch: ScreenPatch) => http.patch<ScreenDevice>(one(id), patch),
  remove: (id: string, reset: boolean) => http.del(`${one(id)}${reset ? '?reset=1' : ''}`),
  action: (id: string, what: 'identify' | 'refresh' | 'reboot') => http.post<{ ok: boolean }>(`${one(id)}/${what}`),
  update: (id: string) => http.post<ScreenDevice>(`${one(id)}/update`),
  log: (id: string) => raw('GET', `${one(id)}/log`),
  restore: (id: string, file: Blob) => raw('POST', `${one(id)}/restore`, file),
  /** The picture the screen shows; `version` makes the browser fetch it again. */
  pictureUrl: (id: string, version: number | string) => `${one(id)}/image.jpg?v=${encodeURIComponent(String(version))}`,
};
