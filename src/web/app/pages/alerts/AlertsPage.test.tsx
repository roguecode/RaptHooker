// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AlertRule } from '@rapthooker/shared';
import { makePill, makeReading, renderWithHub, settle, type FakeRequest } from '../../test/render';
import { AlertsPage } from './AlertsPage';

const slowing: AlertRule = {
  id: 'r1',
  createdAt: 0,
  name: 'Slowing',
  enabled: true,
  pillIds: 'all',
  kind: 'velocity_slow',
  threshold: 1,
  hours: 48,
  onlyDuringBrew: true,
  cooldownMin: 60,
  channelIds: 'all',
  message: '',
  addToTimeline: false,
  active: [],
  waitingForGravity: { 'pill-1': 1.0427 },
};
const RULE = 'PUT /api/alerts/rules/*';

describe('the Alerts page', () => {
  it('says which pills a velocity rule is waiting on, and follows their readings', async () => {
    let waiting = true;
    const view = await renderWithHub(<AlertsPage />, {
      pills: [makePill({ id: 'pill-1', name: 'Yellow Pill' }), makePill({ id: 'pill-2', name: 'Red Pill' })],
      routes: {
        'GET /api/alerts/rules': () => [{ ...slowing, waitingForGravity: waiting ? slowing.waitingForGravity : {} }],
        [RULE]: (req: FakeRequest) => ({ ...slowing, ...(req.body as object) }),
      },
    });
    await settle();
    const text = 'Waiting for Yellow Pill to reach 1.0427, 2 points below where it started its brew';
    expect(screen.getByText(text)).toBeTruthy();

    // It's worked out by the hub, not part of the rule.
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    await waitFor(() => expect(view.calls(RULE)).toHaveLength(1));
    expect(view.calls(RULE)[0]!.body).toMatchObject({ name: 'Slowing', enabled: false });
    expect(view.calls(RULE)[0]!.body).not.toHaveProperty('waitingForGravity');

    waiting = false;
    const rulesLoaded = () => view.calls('GET /api/alerts/rules').length;
    const before = rulesLoaded();
    await view.push({ type: 'reading', pillId: 'pill-2', reading: makeReading() });
    await settle();
    expect(rulesLoaded()).toBe(before);
    await view.push({ type: 'reading', pillId: 'pill-1', reading: makeReading({ gravity: 1.0426 }) });
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
  });
});
