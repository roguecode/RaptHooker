import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_HUB_SETTINGS,
  type BleStatus,
  type HubSettings,
  type LiveMessage,
  type NearbyPill,
  type Pill,
  type Session,
  type UpdateInfo,
} from '@rapthooker/shared';
import { api, errorText } from './api';
import { loadLiveCache, saveLiveCache } from './liveCache';

export type Connection = 'connecting' | 'open' | 'closed';
export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
}

type Listener = (msg: LiveMessage) => void;

interface LiveContext {
  pills: Pill[];
  nearby: NearbyPill[];
  ble: BleStatus | null;
  clockSynced: boolean;
  /** Hub-wide settings (name, default units, ABV formula). */
  hub: HubSettings;
  /** The latest release check, once the hub has sent one. */
  update: UpdateInfo | null;
  connection: Connection;
  loaded: boolean;
  /** When the data on screen was saved, while it comes from this browser's cache because the hub hasn't answered yet. */
  cachedAt: number | null;
  session: Session | null;
  isOwner: boolean;
  refreshSession: () => Promise<void>;
  setSession: (s: Session) => void;
  toasts: Toast[];
  toast: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
  /** Every live message, for pages that want readings, brews or webhook updates. */
  subscribe: (fn: Listener) => () => void;
  /** Applies a pill returned by the API straight away (the live update follows). */
  upsertPill: (pill: Pill) => void;
}

const Ctx = createContext<LiveContext | null>(null);
/** Nothing at all (not even the 15 s heartbeat) for this long means the connection is dead. */
const SILENT_MS = 40_000;
/** On reconnecting, check who's signed in again if it was last checked longer ago than this. */
const SESSION_RECHECK_MS = 60_000;
/** A request for the session still unanswered after this long is likely stuck (sent before the network was up). */
const SESSION_STUCK_MS = 5_000;

export function LiveProvider({ children }: { children: ReactNode }) {
  // Start from the last state this browser saw, so there's something to look at offline (marked by cachedAt).
  const [cache] = useState(loadLiveCache);
  const [pills, setPills] = useState<Pill[]>(cache?.pills ?? []);
  const [nearby, setNearby] = useState<NearbyPill[]>(cache?.nearby ?? []);
  const [ble, setBle] = useState<BleStatus | null>(cache?.ble ?? null);
  const [clockSynced, setClockSynced] = useState(cache?.clockSynced ?? true);
  const [hub, setHub] = useState<HubSettings>(cache?.hub ?? DEFAULT_HUB_SETTINGS);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [loaded, setLoaded] = useState(cache !== null);
  const [cachedAt, setCachedAt] = useState<number | null>(cache?.savedAt ?? null);
  const [session, setSession] = useState<Session | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const listeners = useRef(new Set<Listener>());

  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setToasts((cur) => [...cur, { ...t, id }].slice(-4));
      window.setTimeout(() => dismiss(id), t.tone === 'error' ? 9000 : 5500);
    },
    [dismiss],
  );

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sessionAskedAt = useRef(0);
  const sessionPending = useRef(0);
  const sessionFailures = useRef(0);
  const sessionRetry = useRef<number | undefined>(undefined);
  // Bumped by every change, so an answer that was overtaken (by signing in, say) is dropped.
  const sessionVersion = useRef(0);
  const refreshSession = useCallback(async function ask(): Promise<void> {
    const version = ++sessionVersion.current;
    window.clearTimeout(sessionRetry.current);
    sessionAskedAt.current = Date.now();
    sessionPending.current++;
    try {
      const s = await api.session();
      sessionFailures.current = 0;
      if (version === sessionVersion.current) setSession((cur) => (cur && JSON.stringify(cur) === JSON.stringify(s) ? cur : s));
    } catch (err) {
      console.warn('session', errorText(err));
      // Without a session there isn't even a way to sign in: keep asking while there's none, less often each time.
      if (version === sessionVersion.current && sessionRef.current === null) {
        const wait = Math.min(60_000, 5_000 * 2 ** sessionFailures.current++);
        sessionRetry.current = window.setTimeout(() => void ask(), wait);
      }
    } finally {
      sessionPending.current--;
    }
  }, []);
  const applySession = useCallback((s: Session) => {
    sessionVersion.current++;
    window.clearTimeout(sessionRetry.current);
    setSession(s);
  }, []);

  useEffect(() => {
    void refreshSession();
    return () => window.clearTimeout(sessionRetry.current);
  }, [refreshSession]);

  const upsertPill = useCallback((pill: Pill) => {
    setPills((cur) => (cur.some((p) => p.id === pill.id) ? cur.map((p) => (p.id === pill.id ? pill : p)) : [...cur, pill]));
  }, []);

  // Reconnect when the role changes (signing in or out), so live updates match what this user may see.
  const role = session?.role;
  useEffect(() => {
    let ws: WebSocket | undefined;
    let closed = false;
    let attempt = 0;
    let lastMessage = Date.now();
    let retry: number | undefined;

    const sessionShouldBeAsked = () => {
      const since = Date.now() - sessionAskedAt.current;
      if (sessionRef.current === null) return sessionPending.current === 0 || since > SESSION_STUCK_MS;
      return sessionPending.current === 0 && since > SESSION_RECHECK_MS;
    };

    const handle = (msg: LiveMessage) => {
      switch (msg.type) {
        case 'hello':
          setPills(msg.pills);
          setNearby(msg.nearby);
          setBle(msg.ble);
          setClockSynced(msg.clockSynced);
          if (msg.hub) setHub(msg.hub);
          setLoaded(true);
          setCachedAt(null);
          // The hub is reachable: ask who's signed in if that failed before (a phone still joining the network) or is
          // still unanswered after a while, and now and then anyway (signing in can run out meanwhile).
          if (sessionShouldBeAsked()) void refreshSession();
          break;
        case 'hub':
          setHub(msg.hub);
          break;
        case 'update':
          setUpdate(msg.update);
          break;
        case 'pill':
          upsertPill(msg.pill);
          break;
        case 'pill-removed':
          setPills((cur) => cur.filter((p) => p.id !== msg.pillId));
          break;
        case 'nearby':
          setNearby(msg.nearby);
          break;
        case 'ble':
          setBle(msg.ble);
          setClockSynced(msg.clockSynced);
          break;
        case 'alert':
          toast({ tone: msg.event.kind === 'fired' ? 'warning' : 'success', title: msg.event.ruleName, body: msg.event.message });
          break;
        default:
          break;
      }
      for (const fn of listeners.current) fn(msg);
    };

    const connect = () => {
      setConnection('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${window.location.host}/api/live`);
      ws = socket;
      lastMessage = Date.now();
      socket.addEventListener('open', () => {
        if (socket !== ws) return;
        attempt = 0;
        setConnection('open');
      });
      socket.addEventListener('message', (e) => {
        if (socket !== ws) return;
        lastMessage = Date.now();
        try {
          handle(JSON.parse(String(e.data)) as LiveMessage);
        } catch (err) {
          console.warn('bad live message', err);
        }
      });
      socket.addEventListener('close', () => {
        if (socket !== ws) return;
        setConnection('closed');
        if (closed) return;
        retry = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
      });
      socket.addEventListener('error', () => socket.close());
    };

    const replace = () => {
      const old = ws;
      ws = undefined;
      old?.close();
      window.clearTimeout(retry);
      attempt = 0;
      connect();
    };

    const watchdog = window.setInterval(() => {
      if (!closed && ws?.readyState === WebSocket.OPEN && Date.now() - lastMessage > SILENT_MS) replace();
    }, 10_000);
    // Waking a phone: check the connection straight away rather than waiting for the watchdog.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (ws?.readyState !== WebSocket.OPEN || Date.now() - lastMessage > 20_000)) replace();
    };
    document.addEventListener('visibilitychange', onVisible);

    connect();
    return () => {
      closed = true;
      window.clearInterval(watchdog);
      window.clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
      ws?.close();
    };
  }, [toast, upsertPill, refreshSession, role]);

  // Keep a copy of the live state for offline use: at most every few seconds, and when the page is put away.
  const snapshot = useRef({ pills, nearby, ble, clockSynced, hub });
  snapshot.current = { pills, nearby, ble, clockSynced, hub };
  const saveTimer = useRef<number | undefined>(undefined);
  const live = loaded && cachedAt === null;
  useEffect(() => {
    if (!live || saveTimer.current !== undefined) return;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined;
      saveLiveCache(snapshot.current);
    }, 5000);
  }, [live, pills, nearby, ble, clockSynced, hub]);
  useEffect(() => {
    if (!live) return;
    const flush = () => {
      if (saveTimer.current === undefined) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      saveLiveCache(snapshot.current);
    };
    const onHide = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [live]);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const value = useMemo<LiveContext>(
    () => ({
      pills,
      nearby,
      ble,
      clockSynced,
      hub,
      update,
      connection,
      loaded,
      cachedAt,
      session,
      isOwner: session?.role === 'owner',
      refreshSession,
      setSession: applySession,
      toasts,
      toast,
      dismiss,
      subscribe,
      upsertPill,
    }),
    [
      pills,
      nearby,
      ble,
      clockSynced,
      hub,
      update,
      connection,
      loaded,
      cachedAt,
      session,
      refreshSession,
      applySession,
      toasts,
      toast,
      dismiss,
      subscribe,
      upsertPill,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useLive outside LiveProvider');
  return ctx;
}

/** Runs `fn` for each live message; `fn` can change between renders. */
export function useLiveMessages(fn: Listener): void {
  const { subscribe } = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((m) => ref.current(m)), [subscribe]);
}
