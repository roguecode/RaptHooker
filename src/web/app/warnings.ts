import type { HubWarning } from '@rapthooker/shared';

/** Warnings this browser has dismissed, by id and message (so a changed warning shows again). */
export const DISMISSED_WARNINGS_KEY = 'rapthooker.dismissed-warnings';
const MAX_DISMISSED = 50;

export const warningKey = (w: HubWarning): string => `${w.id}|${w.message}`;

export function parseDismissed(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-MAX_DISMISSED) : [];
  } catch {
    return [];
  }
}

export const serializeDismissed = (keys: string[]): string => JSON.stringify(keys.slice(-MAX_DISMISSED));

/** Warnings worth a banner (warn and error) that haven't been dismissed here. */
export function bannerWarnings(warnings: readonly HubWarning[], dismissed: readonly string[]): HubWarning[] {
  const hidden = new Set(dismissed);
  return warnings.filter((w) => (w.level === 'warn' || w.level === 'error') && !hidden.has(warningKey(w)));
}

/** Forgets dismissals of warnings the hub no longer reports, so the list doesn't grow for ever. */
export function pruneDismissed(dismissed: readonly string[], warnings: readonly HubWarning[]): string[] {
  const current = new Set(warnings.map(warningKey));
  return dismissed.filter((k) => current.has(k));
}
