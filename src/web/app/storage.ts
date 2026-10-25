import { useCallback, useSyncExternalStore } from 'react';

/** localStorage that never throws (private mode, full storage, blocked cookies). */
export function readStored(key: string, storage: 'local' | 'session' = 'local'): string | null {
  try {
    return (storage === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null, storage: 'local' | 'session' = 'local'): void {
  try {
    const s = storage === 'local' ? window.localStorage : window.sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch (err) {
    console.warn('storage', key, err);
  }
  for (const fn of listeners) fn(key);
}

const listeners = new Set<(key: string) => void>();

function subscribe(key: string, onChange: () => void): () => void {
  const local = (k: string) => k === key && onChange();
  // Other tabs.
  const remote = (e: StorageEvent) => (e.key === key || e.key === null) && onChange();
  listeners.add(local);
  window.addEventListener('storage', remote);
  return () => {
    listeners.delete(local);
    window.removeEventListener('storage', remote);
  };
}

/**
 * A value remembered in this browser, shared by every component that uses the same key (and other tabs).
 * `parse` turns the stored text (or null) into a value and should fall back to a default for anything unexpected.
 */
export function useStored<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string = String,
  storage: 'local' | 'session' = 'local',
): [T, (value: T) => void] {
  const raw = useSyncExternalStore(
    useCallback((cb: () => void) => subscribe(key, cb), [key]),
    () => readStored(key, storage),
    () => null,
  );
  const value = parse(raw);
  const set = useCallback((v: T) => writeStored(key, serialize(v), storage), [key, serialize, storage]);
  return [value, set];
}

export const parseFlag = (raw: string | null): boolean => raw === '1';
export const serializeFlag = (v: boolean): string => (v ? '1' : '0');
