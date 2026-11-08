import type {
  Brew,
  BrewAlert,
  BrewAlertInput,
  BrewCurve,
  BrewEvent,
  BrewEventInput,
  BrewProfile,
  BrewProfileInput,
} from '@rapthooker/shared';
import { http } from '../../api';

const base = (brewId: string) => `/api/brews/${encodeURIComponent(brewId)}`;
const profiles = '/api/brew-profiles';

/** Brew events, a brew's own alerts, profiles and comparisons (the rest of the brew calls are in app/api.ts). */
export const brewApi = {
  events: (brewId: string) => http.get<BrewEvent[]>(`${base(brewId)}/events`),
  addEvent: (brewId: string, input: BrewEventInput) => http.post<BrewEvent>(`${base(brewId)}/events`, input),
  updateEvent: (brewId: string, eventId: string, input: BrewEventInput) =>
    http.put<BrewEvent>(`${base(brewId)}/events/${encodeURIComponent(eventId)}`, input),
  deleteEvent: (brewId: string, eventId: string) => http.del(`${base(brewId)}/events/${encodeURIComponent(eventId)}`),
  compare: (ids: string[]) => http.get<BrewCurve[]>(`/api/brews/compare?ids=${ids.map(encodeURIComponent).join(',')}`),

  alerts: (brewId: string) => http.get<BrewAlert[]>(`${base(brewId)}/alerts`),
  addAlert: (brewId: string, input: BrewAlertInput) => http.post<BrewAlert>(`${base(brewId)}/alerts`, input),
  updateAlert: (brewId: string, alertId: string, input: BrewAlertInput) =>
    http.put<BrewAlert>(`${base(brewId)}/alerts/${encodeURIComponent(alertId)}`, input),
  deleteAlert: (brewId: string, alertId: string) => http.del(`${base(brewId)}/alerts/${encodeURIComponent(alertId)}`),

  profiles: () => http.get<BrewProfile[]>(profiles),
  addProfile: (input: BrewProfileInput) => http.post<BrewProfile>(profiles, input),
  updateProfile: (id: string, input: BrewProfileInput) => http.put<BrewProfile>(`${profiles}/${encodeURIComponent(id)}`, input),
  deleteProfile: (id: string) => http.del(`${profiles}/${encodeURIComponent(id)}`),
  /** Adds a profile's alerts and planned events to a running brew. */
  applyProfile: (brewId: string, profileId: string) => http.post<Brew>(`${base(brewId)}/profile`, { profileId }),
};
