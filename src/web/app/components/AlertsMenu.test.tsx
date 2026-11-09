// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { AlertEvent } from '@rapthooker/shared';
import { makePill, renderWithHub, settle, type FakeRequest } from '../test/render';
import { AlertsMenu } from './AlertsMenu';

const event = (over: Partial<AlertEvent> = {}): AlertEvent => ({
  id: 1,
  ruleId: 'r1',
  ruleName: 'Too warm',
  pillId: 'p1',
  at: Date.now() - 5 * 60_000,
  kind: 'fired',
  message: 'Kveik is at 26.0 °C, above 25.0 °C',
  value: 26,
  ackedAt: null,
  brewId: null,
  ...over,
});

const bell = (name: string | RegExp) => screen.getByRole('button', { name });

describe('the alerts bell', () => {
  it('glows with the count of alerts to acknowledge, opens their brew or device, and acknowledges them', async () => {
    const pill = makePill();
    const view = await renderWithHub(<AlertsMenu />, {
      pills: [pill],
      routes: {
        'GET /api/alerts/events': [
          event({ id: 3, ruleName: 'Dry hop', message: 'Add the dry hops', brewId: 'b1', pillId: pill.id }),
          event({ id: 2, pillId: pill.id }),
          event({ id: 1, ruleName: 'Battery low', pillId: 'removed' }),
        ],
        'POST /api/alerts/events/ack': (req: FakeRequest) => ({ acked: (req.body as { ids: unknown }).ids === 'all' ? [1, 2] : [3] }),
      },
    });
    expect(view.calls('GET /api/alerts/events')[0]!.query.get('unacked')).toBe('1');
    const button = bell('3 alerts to acknowledge');
    expect(button.className).toContain('alerting');
    expect(button.textContent).toBe('3');

    fireEvent.click(button);
    expect(screen.getByRole('link', { name: /Dry hop/ }).getAttribute('href')).toBe('#/brew/b1');
    expect(screen.getByRole('link', { name: /Too warm/ }).getAttribute('href')).toBe(`#/pill/${pill.id}`);
    expect(screen.getByRole('link', { name: /Too warm/ }).textContent).toContain(`${pill.name} · 5 min ago`);
    // Its device is gone: nothing to open, still something to acknowledge.
    expect(screen.queryByRole('link', { name: /Battery low/ })).toBeNull();
    expect(screen.getByText('Battery low')).toBeTruthy();
    expect(screen.getByRole('link', { name: /All alerts/ }).getAttribute('href')).toBe('#/alerts');

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge "Dry hop"' }));
    await settle();
    expect(view.calls('POST /api/alerts/events/ack').at(-1)!.body).toEqual({ ids: [3] });
    expect(bell('2 alerts to acknowledge')).toBeTruthy();
    expect(screen.queryByText('Dry hop')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge all' }));
    await settle();
    expect(view.calls('POST /api/alerts/events/ack').at(-1)!.body).toEqual({ ids: 'all' });
    expect(bell('No alerts to acknowledge').className).not.toContain('alerting');
    expect(screen.getByText('Nothing needs looking at.')).toBeTruthy();
  });

  it('follows the hub: alerts going off, and ones acknowledged elsewhere or when their brew ended', async () => {
    const view = await renderWithHub(<AlertsMenu />);
    expect(bell('No alerts to acknowledge')).toBeTruthy();
    await view.push({ type: 'alert', event: event({ id: 7 }) });
    expect(bell('1 alert to acknowledge')).toBeTruthy();
    // One clearing needs nothing.
    await view.push({ type: 'alert', event: event({ id: 8, kind: 'resolved' }) });
    expect(bell('1 alert to acknowledge')).toBeTruthy();
    await view.push({ type: 'alert-acks', ids: [7], at: Date.now() });
    expect(bell('No alerts to acknowledge')).toBeTruthy();
  });

  it('shows them to viewers without letting them acknowledge', async () => {
    await renderWithHub(<AlertsMenu />, {
      session: { role: 'viewer' },
      routes: { 'GET /api/alerts/events': [event({ id: 2 }), event({ id: 1 })] },
    });
    fireEvent.click(bell('2 alerts to acknowledge'));
    expect(screen.getAllByText('Too warm')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Acknowledge/ })).toBeNull();
  });

  it('puts back what it took off when acknowledging fails', async () => {
    await renderWithHub(<AlertsMenu />, {
      routes: {
        'GET /api/alerts/events': [event({ id: 2 }), event({ id: 1, ruleName: 'Battery low' })],
        'POST /api/alerts/events/ack': () => new Response(JSON.stringify({ error: 'Nope' }), { status: 500 }),
      },
    });
    fireEvent.click(bell('2 alerts to acknowledge'));
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge "Battery low"' }));
    await settle();
    expect(bell('2 alerts to acknowledge')).toBeTruthy();
  });
});
