import type { BrewCurve, BrewEvent, BrewEventInput } from '@rapthooker/shared';
import { http } from '../../api';

const base = (brewId: string) => `/api/brews/${encodeURIComponent(brewId)}`;

/** Brew events and comparisons (the rest of the brew calls are in app/api.ts). */
export const brewApi = {
  events: (brewId: string) => http.get<BrewEvent[]>(`${base(brewId)}/events`),
  addEvent: (brewId: string, input: BrewEventInput) => http.post<BrewEvent>(`${base(brewId)}/events`, input),
  updateEvent: (brewId: string, eventId: string, input: BrewEventInput) =>
    http.put<BrewEvent>(`${base(brewId)}/events/${encodeURIComponent(eventId)}`, input),
  deleteEvent: (brewId: string, eventId: string) => http.del(`${base(brewId)}/events/${encodeURIComponent(eventId)}`),
  compare: (ids: string[]) => http.get<BrewCurve[]>(`/api/brews/compare?ids=${ids.map(encodeURIComponent).join(',')}`),
};
