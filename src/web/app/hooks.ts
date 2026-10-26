import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { History, Reading } from '@rapthooker/shared';
import { ApiError, api, errorText } from './api';
import { useLiveMessages } from './live';
import { useNow } from './format';
import { detailRange, mergeHistory, presetRange, type HistoryRange, type RangePreset, type TimeWindow } from './components/chartMath';

export type { HistoryRange, RangePreset, TimeWindow } from './components/chartMath';

/**
 * How long without a reading breaks a chart's line, as the hub works it out for the history: a few of the pill's
 * intervals, from 10 minutes to 3 hours.
 */
export const historyGapMs = (intervalSec: number | null | undefined): number =>
  Math.min(3 * 3_600_000, Math.max(10 * 60_000, (intervalSec ?? 300) * 4000));

/** Adds a live reading to a history (after a row of nulls when there's been a gap). */
export function appendReading(h: History, r: Reading, gapMs: number): History {
  const lastTs = h.ts[h.ts.length - 1];
  if (lastTs !== undefined && r.ts <= lastTs) return h;
  const gap = lastTs !== undefined && r.ts - lastTs > gapMs;
  const add = <T>(arr: T[], v: T, empty: T) => (gap ? [...arr, empty, v] : [...arr, v]);
  const implausible: boolean | null = r.plausible === false;
  return {
    ...h,
    to: Math.max(h.to, r.ts),
    ts: gap ? [...h.ts, Math.round((lastTs! + r.ts) / 2), r.ts] : [...h.ts, r.ts],
    gravity: add(h.gravity, r.gravity as number | null, null),
    temperature: add(h.temperature, r.temperature as number | null, null),
    velocity: add(h.velocity, r.velocity, null),
    battery: add(h.battery, r.battery as number | null, null),
    rssi: add(h.rssi, r.rssi, null),
    tilt: add(h.tilt, r.tilt, null),
    implausible: add(h.implausible ?? h.ts.map(() => null), implausible, null),
    ...(h.pillGravity ? { pillGravity: add(h.pillGravity, (r.pillGravity ?? r.gravity) as number | null, null) } : {}),
    ...(h.pillVelocity ? { pillVelocity: add(h.pillVelocity, r.pillVelocity ?? null, null) } : {}),
  };
}

/** How long to wait before trying a failed load again: longer each time it fails in a row. */
const RETRY_MS = [5_000, 15_000, 30_000, 60_000];
/**
 * A reconnect this soon after a load needn't fetch the history again: the app connects twice as it starts (once more
 * when it knows who's signed in), and the load has everything up to then.
 */
const RECONNECT_GRACE_MS = 10_000;

/** A failure that may well clear up by itself: no answer, or a hub that's restarting or struggling. */
const transient = (err: unknown) => !(err instanceof ApiError) || err.status === 0 || err.status >= 500;

/**
 * A pill's history for a range, kept up to date with live readings when the range runs to now. A different
 * `reloadKey` fetches it again (e.g. when the pill's calibration changes). A null range clears it.
 *
 * Readings sent while the live connection was down never arrive, so a live range is fetched again when the hub says
 * hello on a new connection and has newer readings. A failed load is tried again after a while, and straight away when
 * the hub is back.
 */
export function useHistory(pillId: string | null, range: HistoryRange | null, points = 800, gapMs = 30 * 60_000, reloadKey = '') {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const hasRange = range !== null;
  const loadedAt = useRef(0);
  const failures = useRef(0);
  const retry = useRef<number | undefined>(undefined);
  const latest = useRef<() => Promise<void>>(async () => undefined);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    window.clearTimeout(retry.current);
    if (!pillId || !range) {
      setHistory(null);
      setLoading(false);
      return;
    }
    loadedAt.current = Date.now();
    setLoading(true);
    try {
      // A live range runs to now, however long ago it was worked out.
      const to = range.live ? Math.max(range.to, Date.now()) : range.to;
      const h = await api.history(pillId, range.from, to, points);
      if (mine === seq.current) {
        setHistory(h);
        setError(null);
        failures.current = 0;
      }
    } catch (err) {
      if (mine === seq.current) {
        setError(errorText(err));
        if (transient(err)) {
          const wait = RETRY_MS[Math.min(failures.current++, RETRY_MS.length - 1)]!;
          retry.current = window.setTimeout(() => void latest.current(), wait);
        }
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [pillId, range?.from, range?.to, range?.live, hasRange, points, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  latest.current = load;

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => window.clearTimeout(retry.current), []);

  useLiveMessages((msg) => {
    if (msg.type === 'reading' && msg.pillId === pillId && range?.live) {
      setHistory((h) => (h ? appendReading(h, msg.reading, gapMs) : h));
    } else if (msg.type === 'hello' && pillId && range) {
      if (error !== null) {
        void load();
        return;
      }
      if (!range.live || Date.now() - loadedAt.current < RECONNECT_GRACE_MS) return;
      // Nothing was missed if the pill's latest reading is already here.
      const last = msg.pills.find((p) => p.id === pillId)?.live.lastReadingAt ?? null;
      const have = history?.ts[history.ts.length - 1];
      if (last === null || (have !== undefined && last <= have)) return;
      void load();
    }
  });

  return { history, error, loading, reload: load };
}

/** `value` once `key` has stopped changing for `ms`. */
function useSettled<T>(value: T, key: string, ms: number): T {
  const [settled, setSettled] = useState({ value, key });
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (key === settled.key) return;
    const t = window.setTimeout(() => setSettled({ value: latest.current, key }), ms);
    return () => window.clearTimeout(t);
  }, [key, ms, settled.key]);
  return key === settled.key ? value : settled.value;
}

const ROLLING: RangePreset[] = ['6h', '24h', '3d', '7d', '14d', '30d'];
/** How often rolling ranges move forward. */
const ROLL_MS = 15 * 60_000;

/** The last `ms` up to now, for a small chart that runs for days (TV mode): it moves forward every quarter of an hour. */
export function useRecentRange(ms: number): HistoryRange {
  const tick = useNow(ROLL_MS);
  return useMemo(() => ({ from: tick - ms, to: tick, live: true }), [tick, ms]);
}

/**
 * State for a range picker: a preset (6 hours … everything, or the running brew) or a custom from–to. Rolling presets
 * move forward every quarter of an hour; live readings are added in between.
 */
export function useHistoryRange(opts: { initial: RangePreset; firstAt: number; brewStart?: number | null; brewEnd?: number | null }) {
  const [preset, setPresetState] = useState<RangePreset>(opts.initial);
  const [custom, setCustomState] = useState<TimeWindow | null>(null);
  const tick = useNow(ROLL_MS);
  const effective: RangePreset = preset === 'brew' && !opts.brewStart ? 'all' : preset;
  const rolling = ROLLING.includes(effective) ? tick : 0;
  const range = useMemo(
    () => presetRange(effective, { now: Date.now(), firstAt: opts.firstAt, brewStart: opts.brewStart, brewEnd: opts.brewEnd, custom }),
    // `rolling` moves the window along.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effective, custom, opts.firstAt, opts.brewStart, opts.brewEnd, rolling],
  );
  const setPreset = useCallback((p: Exclude<RangePreset, 'custom'>) => setPresetState(p), []);
  const setCustom = useCallback((win: TimeWindow) => {
    setCustomState(win);
    setPresetState('custom');
  }, []);
  return { preset: effective, setPreset, custom, setCustom, range };
}

/**
 * History for a chart that zooms on the client: the whole range (for the overview strip), and the zoomed-in part
 * fetched in more detail once the view stops moving, merged into one.
 */
export function useZoomableHistory(
  pillId: string | null,
  range: HistoryRange,
  view: TimeWindow | null,
  opts: { points?: number; gapMs?: number; reloadKey?: string } = {},
) {
  const points = opts.points ?? 1500;
  const base = useHistory(pillId, range, points, opts.gapMs, opts.reloadKey);
  const bounds = useMemo<TimeWindow>(
    () => ({ from: range.from, to: Math.max(range.to, base.history?.to ?? 0) }),
    [range.from, range.to, base.history?.to],
  );
  const wanted = base.history ? detailRange(view, bounds, base.history.bucketMs, range.live) : null;
  const settled = useSettled(wanted, wanted ? `${wanted.from}-${wanted.to}-${wanted.live}` : '', wanted ? 350 : 0);
  const detail = useHistory(pillId, settled, points, opts.gapMs, opts.reloadKey);
  const zoomedIn = settled !== null;
  const history = useMemo(() => mergeHistory(base.history, zoomedIn ? detail.history : null), [base.history, zoomedIn, detail.history]);
  return {
    /** The whole range. */
    overview: base.history,
    /** The whole range, with the zoomed-in part in more detail. */
    history,
    bounds,
    loading: base.loading || detail.loading,
    error: base.error ?? detail.error,
  };
}
