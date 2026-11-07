// @vitest-environment happy-dom
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HUB_SETTINGS, type History, type Keg, type LiveMessage, type Pill } from '@rapthooker/shared';
import { emptyHistory, makeBle, makeBrew, makePill, makeReading, renderWithHub, type FakeRequest } from './test/render';
import { appendReading, useCardHistory, useCardRange, useHistory } from './hooks';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HISTORY = 'GET /api/pills/*/history';

/** A history with one reading at `ts`. */
const oneReading =
  (ts: number) =>
  (req: FakeRequest): History => ({
    ...emptyHistory('pill-1', Number(req.query.get('from')), Number(req.query.get('to'))),
    ts: [ts],
    gravity: [1.05],
    temperature: [20],
    velocity: [null],
    battery: [90],
    rssi: [-60],
    tilt: [30],
    implausible: [false],
  });

const hello = (pills: Pill[]): LiveMessage => ({
  type: 'hello',
  pills,
  nearby: [],
  ble: makeBle(),
  clockSynced: true,
  hub: DEFAULT_HUB_SETTINGS,
});

function Probe() {
  const range = useMemo(() => ({ from: Date.now() - DAY, to: Date.now(), live: true }), []);
  const { history, error } = useHistory('pill-1', range, 160);
  return <p data-testid="probe">{error ? `error: ${error}` : history ? `${history.ts.length} readings` : 'loading'}</p>;
}

/** Moves the clock on, as if the page had been put away for a while. */
function later(ms: number) {
  const now = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => now() + ms);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useHistory', () => {
  it('fetches a live range again after reconnecting, when the hub has readings it missed', async () => {
    const pill = makePill({ id: 'pill-1', live: { lastReadingAt: Date.now() - MIN } });
    const view = await renderWithHub(<Probe />, { pills: [pill], routes: { [HISTORY]: oneReading(Date.now() - 5 * MIN) } });
    expect(screen.getByTestId('probe').textContent).toBe('1 readings');
    // Connecting twice as the app starts doesn't fetch it again.
    expect(view.calls(HISTORY)).toHaveLength(1);

    later(10 * MIN);
    await view.reconnect();
    await waitFor(() => expect(view.calls(HISTORY)).toHaveLength(2));
    const [first, second] = view.calls(HISTORY);
    // Up to now, not to when the range was worked out.
    expect(Number(second!.query.get('to'))).toBeGreaterThan(Number(first!.query.get('to')) + 9 * MIN);
  });

  it("doesn't fetch it again when nothing was missed", async () => {
    const pill = makePill({ id: 'pill-1', live: { lastReadingAt: Date.now() - 10 * MIN } });
    const view = await renderWithHub(<Probe />, { pills: [pill], routes: { [HISTORY]: oneReading(Date.now() - 10 * MIN) } });
    later(10 * MIN);
    await view.reconnect();
    expect(view.calls(HISTORY)).toHaveLength(1);
  });

  it('tries a failed load again when the hub answers', async () => {
    const pill = makePill({ id: 'pill-1' });
    let up = false;
    const view = await renderWithHub(<Probe />, {
      pills: [pill],
      routes: {
        [HISTORY]: (req: FakeRequest) =>
          up ? oneReading(Date.now() - MIN)(req) : new Response('{"error":"The hub is restarting"}', { status: 503 }),
      },
    });
    await screen.findByText('error: The hub is restarting');

    up = true;
    await view.push(hello([pill]));
    await screen.findByText('1 readings');
  });
});

describe('useCardRange', () => {
  const NOW = 1_800_000_000_000;
  const range = (over: Parameters<typeof makePill>[0]) => renderHook(() => useCardRange(makePill(over)));

  it('covers the running brew or keg from its start', () => {
    vi.useFakeTimers({ now: NOW });
    const brew = makeBrew({ startedAt: NOW - 9 * DAY });
    expect(range({ brew, live: { firstReadingAt: NOW - 30 * DAY } }).result.current).toEqual({ from: NOW - 9 * DAY, to: NOW, live: true });
    const keg: Keg = {
      id: 'keg-1',
      pillId: 'pill-1',
      name: '',
      style: '',
      abv: null,
      brewId: null,
      keggedAt: NOW - 3 * DAY,
      endedAt: null,
      createdAt: NOW - 3 * DAY,
      startVolume: null,
    };
    expect(range({ keg, live: { firstReadingAt: NOW - 30 * DAY } }).result.current.from).toBe(NOW - 3 * DAY);
  });

  it('covers the last 24 hours otherwise, or everything when there is less', () => {
    vi.useFakeTimers({ now: NOW });
    expect(range({ live: { firstReadingAt: NOW - 30 * DAY } }).result.current).toEqual({ from: NOW - DAY, to: NOW, live: true });
    expect(range({ live: { firstReadingAt: NOW - 5 * 60 * MIN } }).result.current.from).toBe(NOW - 5 * 60 * MIN);
  });

  it('moves forward every quarter of an hour', () => {
    vi.useFakeTimers({ now: NOW });
    const { result } = range({ live: { firstReadingAt: NOW - 30 * DAY } });
    act(() => {
      vi.advanceTimersByTime(15 * MIN);
    });
    expect(result.current).toEqual({ from: NOW + 15 * MIN - DAY, to: NOW + 15 * MIN, live: true });
  });

  it('starts at a brew started since the window last moved', () => {
    vi.useFakeTimers({ now: NOW });
    const { result, rerender } = renderHook(({ pill }) => useCardRange(pill), { initialProps: { pill: makePill() } });
    act(() => {
      vi.advanceTimersByTime(5 * MIN);
    });
    rerender({ pill: makePill({ brew: makeBrew({ startedAt: NOW + 5 * MIN }) }) });
    expect(result.current).toEqual({ from: NOW + 5 * MIN, to: NOW + 5 * MIN, live: true });
  });
});

describe('useCardHistory', () => {
  const H = 60 * MIN;
  const now = Date.now();
  const excluded = { id: 'x1', from: now - 4 * H, to: now - 3 * H, createdAt: now - H };
  const pill = makePill({ id: 'pill-1', exclusions: [excluded] });
  /** Readings every 15 minutes over the last 6 hours, with a knock in the excluded range (left out when asked). */
  const knocked = (req: FakeRequest): History => {
    const ts = Array.from({ length: 21 }, (_, i) => now - 6 * H + i * 15 * MIN);
    const inside = (t: number) => t >= excluded.from && t <= excluded.to;
    const leaveOut = req.query.get('exclude') === '1';
    const col = (f: (t: number) => number) => ts.map((t) => (inside(t) && leaveOut ? null : f(t)));
    return {
      ...emptyHistory('pill-1', now - 6 * H, now),
      ts,
      gravity: col((t) => (inside(t) ? 1.2 : 1.05)),
      temperature: col(() => 20),
      velocity: ts.map(() => null),
      battery: col(() => 90),
      rssi: col(() => -60),
      tilt: col(() => 30),
      implausible: ts.map(() => false),
    };
  };

  function CardProbe() {
    const range = useMemo(() => ({ from: now - 6 * H, to: now, live: true }), []);
    const { history } = useCardHistory(pill, range);
    const g = history?.gravity ?? [];
    return (
      <p data-testid="card">
        {history ? `top ${Math.max(...g.map((v) => v ?? 0)).toFixed(3)}, ${g.filter((v) => v === null).length} gaps` : 'loading'}
      </p>
    );
  }

  /** The same, with exclusions switched off in this browser. */
  function Off() {
    useState(() => localStorage.setItem('rapthooker.exclusions', 'off'));
    return <CardProbe />;
  }

  it("fills in the pill's excluded ranges, as its charts do", async () => {
    const view = await renderWithHub(<CardProbe />, { pills: [pill], routes: { [HISTORY]: knocked } });
    await screen.findByText('top 1.050, 0 gaps');
    expect(view.calls(HISTORY).every((r) => r.query.get('exclude') === '1')).toBe(true);
  });

  it('shows the readings when exclusions are switched off in this browser', async () => {
    const view = await renderWithHub(<Off />, { pills: [pill], routes: { [HISTORY]: knocked } });
    await screen.findByText('top 1.200, 0 gaps');
    expect(view.calls(HISTORY).some((r) => r.query.get('exclude') === '1')).toBe(false);
  });
});

describe('appendReading', () => {
  it("adds a Laser Level's distance to a history that has them", () => {
    const h = {
      ...emptyHistory('laser-1', 0, 1000),
      ts: [1000],
      temperature: [4],
      gravity: [null],
      velocity: [null],
      battery: [86],
      rssi: [-60],
      tilt: [null],
      implausible: [false],
      distance: [293],
    };
    const next = appendReading(h, makeReading({ ts: 61_000, gravity: null, distance: 300 }), 30 * MIN);
    expect(next.distance).toEqual([293, 300]);
    expect(appendReading(emptyHistory('pill-1', 0, 1000), makeReading({ ts: 61_000 }), 30 * MIN).distance).toBeUndefined();
  });
});
