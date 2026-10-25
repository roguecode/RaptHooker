// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeBrew, makeNearby, makePill, makeReading, renderWithHub, toastTexts } from '../../test/render';
import { Dashboard } from '../Dashboard';

const stout = () => makePill({ id: 'pill-1', name: 'Oatmeal Stout', brew: makeBrew({ name: 'Stout #2', pillId: 'pill-1' }) });
const lager = () =>
  makePill({
    id: 'pill-2',
    name: 'Czech Pils',
    address: 'F0:0D:5E:ED:00:04',
    order: 1,
    live: { latest: makeReading({ gravity: 1.0456, temperature: 11.04, velocity: null }) },
  });

const card = (name: string) => screen.getByRole('link', { name }).closest('article')!;

describe('Dashboard', () => {
  it('shows a card for each pill from the live state', async () => {
    await renderWithHub(<Dashboard />, { pills: [stout(), lager()] });

    expect(screen.getByRole('heading', { name: 'Your pills' })).toBeTruthy();
    expect(screen.getByText('2 pills recording · 1 brew on the go')).toBeTruthy();
    const pils = within(card('Czech Pils'));
    expect(pils.getByText('11.0 °C')).toBeTruthy();
    expect(card('Czech Pils').querySelector('.gravity-value')?.textContent).toBe('1.0456SG');
    expect(pils.getByText('Idle')).toBeTruthy();
    expect(pils.getByText('Velocity not ready yet')).toBeTruthy();
    const stoutCard = within(card('Oatmeal Stout'));
    expect(stoutCard.getByText('Brewing')).toBeTruthy();
    expect(stoutCard.getByText('-4.2 pts/day')).toBeTruthy();
    expect(stoutCard.getByRole('progressbar', { name: 'Fermentation progress' })).toBeTruthy();
    expect(screen.getByText('Simulated pills')).toBeTruthy();
    expect(screen.queryByText(/Let's get your first pill recording/)).toBeNull();
  });

  it('follows live updates', async () => {
    const view = await renderWithHub(<Dashboard />, { pills: [lager()] });
    expect(within(card('Czech Pils')).getByText('11.0 °C')).toBeTruthy();

    const next = lager();
    next.live.latest = makeReading({ temperature: 12.5, gravity: 1.044 });
    await view.push({ type: 'pill', pill: next });
    expect(within(card('Czech Pils')).getByText('12.5 °C')).toBeTruthy();

    await view.push({ type: 'pill-removed', pillId: 'pill-2' });
    expect(screen.queryByRole('link', { name: 'Czech Pils' })).toBeNull();
  });

  it('warns when the gravity looks wrong', async () => {
    const sunk = makePill({ live: { latest: makeReading({ gravity: 1.31, plausible: false }) } });
    await renderWithHub(<Dashboard />, { pills: [sunk] });
    expect(screen.getByText('Gravity looks wrong: is the pill floating?')).toBeTruthy();
  });

  it('guides a new hub and adds a pill found nearby', async () => {
    const added = makePill({ id: 'pill-new', name: 'Pill 2', address: 'F0:0D:5E:ED:00:04' });
    const view = await renderWithHub(<Dashboard />, { routes: { 'POST /api/pills': added } });

    expect(screen.getByRole('heading', { name: /Let's get your first pill recording/ })).toBeTruthy();
    expect(screen.getByText('1 of 3 done. Each step ticks itself off.')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Setup progress' }).getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByText(/It shows up below as “Found a RAPT Pill nearby”/)).toBeTruthy();
    expect(screen.getByText('The hub is listening now.')).toBeTruthy();

    await view.push({ type: 'nearby', nearby: [makeNearby()] });
    expect(screen.getByText('Found a pill nearby')).toBeTruthy();
    const nearby = within(screen.getByRole('region', { name: 'Pills nearby' }));
    expect(nearby.getByText(/1\.0480 · 11\.0 °C · Signal: Good \(-70 dBm\)/)).toBeTruthy();

    fireEvent.change(nearby.getByRole('textbox', { name: /Name for the pill/ }), { target: { value: '  Pill 2 ' } });
    fireEvent.click(nearby.getByRole('button', { name: 'Add pill' }));
    await waitFor(() => expect(window.location.hash).toBe('#/pill/pill-new'));
    expect(view.calls('POST /api/pills')[0]!.body).toEqual({ address: 'F0:0D:5E:ED:00:04', name: 'Pill 2' });
    expect(toastTexts()).toContain('Pill 2 added: Recording has started.');
  });

  it('asks a viewer to sign in before adding a pill', async () => {
    await renderWithHub(<Dashboard />, { nearby: [makeNearby()], session: { role: 'viewer', via: 'lan' } });
    expect(screen.getByRole('link', { name: 'Sign in to add it' }).getAttribute('href')).toBe('#/settings');
    expect(screen.queryByRole('button', { name: 'Add pill' })).toBeNull();
    expect(screen.getByText(/sign in with the owner PIN to add it/)).toBeTruthy();
  });

  it('switches to the compact view and remembers it', async () => {
    await renderWithHub(<Dashboard />, { pills: [stout(), lager()] });
    expect(screen.queryByRole('list', { name: 'Pills' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    const rows = within(screen.getByRole('list', { name: 'Pills' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(/Stout #2/)).toBeTruthy();
    expect(within(rows[1]!).getByText(/No brew/)).toBeTruthy();
    expect(within(rows[1]!).getByText('1.0456')).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByRole('button', { name: 'Compact' }).getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('rapthooker.dashboard.view')).toBe('compact');

    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('filters to pills with a brew on the go', async () => {
    await renderWithHub(<Dashboard />, { pills: [stout(), lager()] });
    const filter = screen.getByRole('button', { name: 'Brewing only' });
    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('link', { name: 'Oatmeal Stout' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Czech Pils' })).toBeNull();

    fireEvent.click(filter);
    expect(screen.getByRole('link', { name: 'Czech Pils' })).toBeTruthy();
  });

  it('says so when nothing is brewing', async () => {
    await renderWithHub(<Dashboard />, { pills: [lager()] });
    fireEvent.click(screen.getByRole('button', { name: 'Brewing only' }));
    expect(screen.getByRole('heading', { name: 'No brews on the go' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all pills' }));
    expect(screen.getByRole('link', { name: 'Czech Pils' })).toBeTruthy();
  });
});
