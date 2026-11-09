// @vitest-environment happy-dom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '@rapthooker/shared';
import type { ChartAnnotation } from '../../components/annotations';
import { makeBrew, makePill, makeReading, renderWithHub } from '../../test/render';
import { PillPage } from './PillPage';

const chart = vi.hoisted(() => ({ annotations: [] as ChartAnnotation[] }));

// The chart draws on a canvas, which happy-dom doesn't have.
vi.mock('../../components/Chart', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Chart: (props: { annotations?: ChartAnnotation[] }) => {
    chart.annotations = props.annotations ?? [];
    return null;
  },
}));

/** The button that folds a panel, by its heading. */
const toggle = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('h2 > .panel-toggle')].find((b) => b.textContent?.trim() === name)!;
const pressed = (title: string) => screen.getByRole('button', { name: title }).getAttribute('aria-pressed');

describe('pill page', () => {
  it('shows the brew, history, data and settings in that order, with data and settings folded', async () => {
    const pill = makePill({ brew: makeBrew() });
    await renderWithHub(<PillPage id={pill.id} />, { pills: [pill] });

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim());
    expect(headings).toEqual(['Hazy IPA #4', 'History', 'Data', 'Pill settings']);
    expect(toggle('Hazy IPA #4').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('History').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Data').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('Pill settings').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Latest values' })).toBeNull();
    expect(screen.queryByLabelText(/^Temperature offset/)).toBeNull();

    fireEvent.click(toggle('Data'));
    expect(toggle('Data').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Latest values' })).toBeTruthy();
    fireEvent.click(toggle('Pill settings'));
    expect(screen.getByLabelText(/^Temperature offset/)).toBeTruthy();
    fireEvent.click(toggle('History'));
    expect(screen.queryByRole('group', { name: 'Time range' })).toBeNull();
    // Remembered for next time.
    expect(JSON.parse(localStorage.getItem('rapthooker.panels')!)).toEqual({
      'pill.data': true,
      'pill.settings': true,
      'pill.history': false,
    });
  });

  it("shows a pill's history since the brew started, or the last day without one", async () => {
    const pill = makePill();
    const view = await renderWithHub(<PillPage id={pill.id} />, { pills: [pill] });
    expect(screen.getByRole('heading', { level: 2, name: 'Brew' })).toBeTruthy();
    expect(pressed('Last 24 hours')).toBe('true');

    // A brew started while the page is open.
    await view.push({ type: 'pill', pill: { ...pill, brew: makeBrew() } });
    expect(pressed('Since the brew started')).toBe('true');
  });

  it('starts on the brew when one is running', async () => {
    const pill = makePill({ brew: makeBrew() });
    await renderWithHub(<PillPage id={pill.id} />, { pills: [pill] });
    expect(pressed('Since the brew started')).toBe('true');
  });

  it('marks when alerts went off and cleared on the chart, unless turned off', async () => {
    const pill = makePill();
    const now = Date.now();
    const event = (id: number, kind: AlertEvent['kind'], minutesAgo: number): AlertEvent => ({
      id,
      ruleId: 'r1',
      ruleName: 'Too warm',
      pillId: pill.id,
      at: now - minutesAgo * 60_000,
      kind,
      message: '',
      value: 25,
      ackedAt: null,
      brewId: null,
    });
    const view = await renderWithHub(<PillPage id={pill.id} />, {
      pills: [pill],
      routes: { 'GET /api/alerts/events': [event(2, 'resolved', 30), event(1, 'fired', 90)] },
    });
    expect(view.calls('GET /api/alerts/events').map((r) => r.query.get('pillId'))).toContain(pill.id);
    const labels = () => chart.annotations.map((a) => a.label);
    expect(labels()).toEqual(['Alert: Too warm', 'OK: Too warm']);

    // One going off while the page is open is added.
    await view.push({ type: 'alert', event: event(3, 'fired', 1) });
    expect(labels()).toEqual(['Alert: Too warm', 'OK: Too warm', 'Alert: Too warm']);

    expect(pressed('Alerts')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(labels()).toEqual([]);
    expect(localStorage.getItem('rapthooker.chart.alerts')).toBe('0');
  });

  it("doesn't offer to mark alerts when there are none", async () => {
    const pill = makePill();
    await renderWithHub(<PillPage id={pill.id} />, { pills: [pill] });
    expect(screen.queryByRole('button', { name: 'Alerts' })).toBeNull();
    expect(chart.annotations).toEqual([]);
  });

  it("warns that the pill doesn't seem to be floating with the data folded", async () => {
    const pill = makePill({ live: { latest: makeReading({ gravity: 1.2, pillGravity: 1.2, plausible: false }) } });
    await renderWithHub(<PillPage id={pill.id} />, { pills: [pill] });
    expect(screen.getByRole('status').textContent).toContain('This reading looks wrong: is the pill floating?');
  });

  it('shows poor reception in the heading of the folded data', async () => {
    const now = Date.now();
    const pill = makePill({ live: { rssi: -91, caught: { since: now - 6 * 3_600_000, expected: 72, received: 50 } } });
    await renderWithHub(<PillPage id={pill.id} />, { pills: [pill] });
    const heading = screen.getByRole('heading', { level: 2, name: /^Data/ });
    expect(heading.textContent).toContain('Readings caught: 69%');
    expect(heading.textContent).toContain('Signal: Weak');

    fireEvent.click(toggle('Data'));
    expect(heading.textContent?.trim()).toBe('Data');
  });

  it('folds the settings of a thermometer too, and has no brew', async () => {
    const thermometer = makePill({ kind: 'thermometer', address: 'F0:0D:5E:ED:00:10' });
    await renderWithHub(<PillPage id={thermometer.id} />, { pills: [thermometer] });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim());
    expect(headings).toEqual(['History', 'Data', 'Thermometer settings']);
    expect(toggle('Thermometer settings').getAttribute('aria-expanded')).toBe('false');
  });
});
