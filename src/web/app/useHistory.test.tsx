// @vitest-environment happy-dom
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HUB_SETTINGS, type History, type LiveMessage, type Pill } from '@rapthooker/shared';
import { emptyHistory, makeBle, makePill, renderWithHub, type FakeRequest } from './test/render';
import { useHistory, useRecentRange } from './hooks';

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

describe('useRecentRange', () => {
  it('moves forward every quarter of an hour', () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { result } = renderHook(() => useRecentRange(DAY));
    expect(result.current).toEqual({ from: 1_800_000_000_000 - DAY, to: 1_800_000_000_000, live: true });
    act(() => {
      vi.advanceTimersByTime(15 * MIN);
    });
    expect(result.current).toEqual({ from: 1_800_000_000_000 + 15 * MIN - DAY, to: 1_800_000_000_000 + 15 * MIN, live: true });
  });
});
