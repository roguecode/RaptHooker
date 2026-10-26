/**
 * Renders web app components for tests without a hub: inside the real LiveProvider and UnitsProvider, with a fake
 * WebSocket that sends the live state you give it and a fake fetch that answers from a table of routes.
 * Needs the happy-dom environment (`// @vitest-environment happy-dom` at the top of the test file).
 * Importing this file cleans up after every test (unmounts, restores fetch and WebSocket, clears storage).
 */
import { act, cleanup, render, waitFor, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, vi } from 'vitest';
import {
  DEFAULT_HUB_SETTINGS,
  DEFAULT_PILL_MODEL,
  type BleStatus,
  type Brew,
  type BrewStats,
  type History,
  type HubSettings,
  type LiveMessage,
  type NearbyPill,
  type Pill,
  type PillLive,
  type PillModel,
  type Reading,
  type Session,
} from '@rapthooker/shared';
import { LiveProvider, useLive } from '../live';
import { UnitsProvider } from '../units';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Sample data. The addresses are the simulator's made-up ones.

export function makeReading(over: Partial<Reading> = {}): Reading {
  return {
    ts: Date.now() - 60_000,
    gravity: 1.0123,
    temperature: 19.2,
    velocity: -4.2,
    battery: 87,
    rssi: -62,
    tilt: 31.5,
    x: 520,
    y: 4,
    z: 880,
    plausible: true,
    pillGravity: 1.0123,
    pillVelocity: -4.2,
    ...over,
  };
}

export type PillOverrides = Partial<Omit<Pill, 'live' | 'model'>> & { live?: Partial<PillLive>; model?: Partial<PillModel> };

export function makePill(over: PillOverrides = {}): Pill {
  const { live, model, ...rest } = over;
  const now = Date.now();
  return {
    id: 'pill-1',
    kind: 'pill',
    address: 'F0:0D:5E:ED:00:03',
    raptId: 'F0:0D:5E:ED:00:01',
    name: 'Hazy IPA',
    color: '#8b5cf6',
    createdAt: now - 5 * DAY,
    archived: false,
    offsets: { gravity: 0, temperature: 0 },
    order: 0,
    info: { firmware: '20250319_mock_ale', deviceType: 'PillG1', payloadVersion: 2 },
    brew: null,
    ...rest,
    model: { ...DEFAULT_PILL_MODEL, ...model },
    live: {
      lastHeardAt: now - 30_000,
      lastReadingAt: now - 60_000,
      firstReadingAt: now - 5 * DAY,
      online: true,
      rssi: -62,
      intervalSec: 300,
      latest: makeReading(),
      computedVelocity: null,
      caught: { since: now - DAY, expected: 288, received: 280 },
      ...live,
    },
  };
}

export function makeBrew(over: Partial<Omit<Brew, 'stats'>> & { stats?: Partial<BrewStats> } = {}): Brew {
  const { stats, ...rest } = over;
  const now = Date.now();
  return {
    id: 'brew-1',
    pillId: 'pill-1',
    name: 'Hazy IPA #4',
    style: 'New England IPA',
    notes: '',
    og: null,
    targetFg: 1.012,
    startedAt: now - 3 * DAY,
    endedAt: null,
    events: [],
    ...rest,
    stats: {
      og: 1.054,
      ogAuto: true,
      gravity: 1.0123,
      abv: 5.5,
      attenuation: 77,
      tempMin: 18.5,
      tempMax: 20.6,
      tempAvg: 19.4,
      readings: 800,
      firstReadingAt: now - 3 * DAY,
      lastReadingAt: now - 60_000,
      stable: false,
      finalAbv: null,
      prediction: null,
      ...stats,
    },
  };
}

export function makeNearby(over: Partial<NearbyPill> = {}): NearbyPill {
  const now = Date.now();
  return {
    address: 'F0:0D:5E:ED:00:04',
    kind: 'pill',
    raptId: 'F0:0D:5E:ED:00:02',
    firstHeardAt: now - 5 * 60_000,
    lastHeardAt: now - 20_000,
    rssi: -70,
    latest: makeReading({ gravity: 1.048, pillGravity: 1.048, temperature: 11 }),
    info: { firmware: null, deviceType: null, payloadVersion: 2 },
    ...over,
  };
}

export function makeBle(over: Partial<BleStatus> = {}): BleStatus {
  return {
    state: 'mock',
    adapter: 'simulated',
    adapters: ['simulated'],
    mode: null,
    error: null,
    lastAdvertAt: Date.now(),
    since: Date.now() - HOUR,
    relays: [],
    ...over,
  };
}

export function makeSession(over: Partial<Session> = {}): Session {
  return { role: 'owner', user: 'localhost', via: 'localhost', secure: false, pinSet: true, ...over };
}

export function emptyHistory(pillId: string, from = Date.now() - DAY, to = Date.now()): History {
  return {
    pillId,
    from,
    to,
    bucketMs: 0,
    ts: [],
    gravity: [],
    temperature: [],
    velocity: [],
    battery: [],
    rssi: [],
    tilt: [],
    implausible: [],
  };
}

// The fake hub

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The JSON body, parsed. */
  body: unknown;
}

/**
 * Answers keyed by "METHOD /path", e.g. "GET /api/webhooks"; `*` matches one path segment. A function is called
 * with the request (it may return a Response, or throw); undefined is sent as 204, anything else as JSON.
 */
export type Routes = Record<string, unknown>;

export interface FakeHub {
  pills?: Pill[];
  nearby?: NearbyPill[];
  /** null: no Bluetooth status yet. */
  ble?: BleStatus | null;
  hub?: Partial<HubSettings>;
  clockSynced?: boolean;
  /** Who is looking: the owner (with a PIN set) unless changed. */
  session?: Partial<Session>;
  routes?: Routes;
  /**
   * Mounts the component only once the session and live state are in, like a dialog opened from a loaded page
   * (forms that take the hub's units when they open need this). Otherwise it mounts straight away, as a page does.
   */
  afterLoad?: boolean;
}

export interface HubRender extends RenderResult {
  /** Every API request, oldest first. */
  requests: FakeRequest[];
  /** The requests to one route, e.g. "POST /api/brews". */
  calls: (route: string) => FakeRequest[];
  /** Sends a live message, as the hub would. */
  push: (msg: LiveMessage) => Promise<void>;
  /** Drops the live connection and lets the app connect again straight away, as when a phone wakes up. */
  reconnect: () => Promise<void>;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function routePattern(key: string): { method: string; re: RegExp } {
  const [method = '', path = ''] = key.split(' ');
  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+');
  return { method: method.toUpperCase(), re: new RegExp(`^${escaped}$`) };
}

function findAnswer(routes: Routes, method: string, path: string): { found: boolean; answer: unknown } {
  // Later keys win, so a test's own routes override the defaults.
  for (const key of Object.keys(routes).reverse()) {
    const p = routePattern(key);
    if (p.method === method && p.re.test(path)) return { found: true, answer: routes[key] };
  }
  return { found: false, answer: undefined };
}

let hello: LiveMessage | null = null;
let sockets: FakeSocket[] = [];

/** Stands in for the browser's WebSocket: it opens straight away and sends the hello. */
class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    sockets.push(this);
    setTimeout(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event('open'));
      if (hello) this.receive(hello);
    }, 0);
  }

  receive(msg: LiveMessage): void {
    if (this.readyState === FakeSocket.OPEN) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
  }

  send(): void {}

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

/** Lets timers, fetches and the live connection catch up. */
export async function settle(rounds = 4): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

/** What the providers have got to, so rendering can wait until the session and live state are in. */
let ready = false;

/** The live state's toasts (the app shows them in its shell, which these tests don't render). */
function Toasts() {
  const { toasts, session, loaded, connection } = useLive();
  ready = session !== null && loaded && connection === 'open';
  return (
    <ul aria-label="Toasts">
      {toasts.map((x) => (
        <li key={x.id} data-tone={x.tone}>
          {x.title}
          {x.body ? `: ${x.body}` : ''}
        </li>
      ))}
    </ul>
  );
}

function AfterLoad({ children }: { children: ReactNode }) {
  const { session, loaded } = useLive();
  return session !== null && loaded ? children : null;
}

/** The toasts shown so far, as "Title: body". */
export const toastTexts = (): string[] => [...document.querySelectorAll('ul[aria-label="Toasts"] li')].map((li) => li.textContent ?? '');

/** Renders `ui` connected to a fake hub with the given live state and API answers. */
export async function renderWithHub(ui: ReactElement, fake: FakeHub = {}): Promise<HubRender> {
  localStorage.clear();
  sessionStorage.clear();
  hello = {
    type: 'hello',
    pills: fake.pills ?? [],
    nearby: fake.nearby ?? [],
    ble: (fake.ble === undefined ? makeBle() : fake.ble) as BleStatus,
    clockSynced: fake.clockSynced ?? true,
    hub: { ...DEFAULT_HUB_SETTINGS, ...fake.hub },
  };
  const routes: Routes = {
    'GET /api/session': makeSession(fake.session),
    'GET /api/pills/*/history': (req: FakeRequest) =>
      emptyHistory(req.path.split('/')[3] ?? '', Number(req.query.get('from')) || undefined, Number(req.query.get('to')) || undefined),
    'GET /api/webhooks': [],
    'GET /api/alerts/rules': [],
    'GET /api/alerts/events': [],
    'GET /api/channels': [],
    ...fake.routes,
  };
  const requests: FakeRequest[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://hub.test');
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown = init?.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {}
      }
      const req: FakeRequest = { method, path: url.pathname, query: url.searchParams, body };
      requests.push(req);
      const { found, answer } = findAnswer(routes, method, url.pathname);
      if (!found) return json({ error: `The test hub has no answer for ${method} ${url.pathname}` }, 404);
      const value = typeof answer === 'function' ? await (answer as (r: FakeRequest) => unknown)(req) : answer;
      if (value instanceof Response) return value;
      return value === undefined ? new Response(null, { status: 204 }) : json(value);
    }),
  );
  vi.stubGlobal('WebSocket', FakeSocket);

  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveProvider>
      <UnitsProvider>
        {fake.afterLoad ? <AfterLoad>{children}</AfterLoad> : children}
        <Toasts />
      </UnitsProvider>
    </LiveProvider>
  );
  ready = false;
  const view = render(ui, { wrapper });
  // Signing in reconnects the live updates, so wait for the session and the connection that follows it.
  await waitFor(() => {
    if (!ready || sockets.at(-1)?.readyState !== FakeSocket.OPEN) throw new Error('The fake hub is still connecting');
  });
  await settle();

  return {
    ...view,
    requests,
    calls: (route) => {
      const p = routePattern(route);
      return requests.filter((r) => r.method === p.method && p.re.test(r.path));
    },
    push: async (msg) => {
      await act(async () => {
        for (const s of sockets) s.receive(msg);
      });
    },
    reconnect: async () => {
      const before = sockets.length;
      await act(async () => {
        for (const s of sockets) s.close();
        // Coming back to the page checks the connection straight away.
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => {
        if (sockets.length === before || sockets.at(-1)?.readyState !== FakeSocket.OPEN)
          throw new Error('The fake hub is still reconnecting');
      });
      await settle();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  hello = null;
  ready = false;
  sockets = [];
  localStorage.clear();
  sessionStorage.clear();
  if (window.location.hash) window.location.hash = '';
});
