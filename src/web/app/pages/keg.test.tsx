// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VESSEL, type Keg } from '@rapthooker/shared';
import { makeBrew, makePill, makeReading, renderWithHub, toastTexts, type PillOverrides } from '../test/render';
import { UnitToggles, VOLUME_KEY } from '../units';
import { Dashboard } from './Dashboard';
import { LaserCard } from './dashboard/LaserCard';
import { KegModal, KegPanel } from './pill/KegPanel';
import { PillPage } from './pill/PillPage';
import { PillSettings } from './pill/PillSettings';

// The chart draws on a canvas, which happy-dom doesn't have.
vi.mock('../components/Chart', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Chart: () => null,
}));

const DAY = 86_400_000;
const LASER = 'D8:3B:DA:44:55:66';
const noGravity = { gravity: null, pillGravity: null, velocity: null, pillVelocity: null, tilt: null, x: null, y: null, z: null };

/** A Laser Level on a 19 L keg, half full. */
const laser = (over: PillOverrides = {}) =>
  makePill({
    id: 'laser-1',
    kind: 'laser-level',
    name: 'Kegerator left',
    address: LASER,
    raptId: LASER,
    vessel: DEFAULT_VESSEL,
    servingUnit: null,
    keg: null,
    info: { firmware: '1.0', deviceType: 'RAPT Laser Level', payloadVersion: null },
    live: {
      latest: makeReading({ ...noGravity, temperature: 4, battery: 86, rssi: -61, distance: 293, fill: 50, volume: 9.5 }),
      rssi: -61,
      intervalSec: 60,
    },
    ...over,
  });

const makeKeg = (over: Partial<Keg> = {}): Keg => ({
  id: 'keg-1',
  pillId: 'laser-1',
  name: 'Citra pale',
  style: 'American Pale Ale',
  abv: 5.2,
  brewId: null,
  keggedAt: Date.now() - 2 * DAY,
  endedAt: null,
  createdAt: Date.now() - 2 * DAY,
  startVolume: 19,
  ...over,
});

const card = (name: string) => screen.getByRole('link', { name }).closest('article')!;

describe('Kegging up a beer', () => {
  it('fills the beer in from a brew, which can still be changed', async () => {
    const l = laser();
    const view = await renderWithHub(<KegPanel pill={l} />, {
      pills: [l],
      routes: {
        'GET /api/kegs': [],
        'GET /api/brews': [
          makeBrew({ id: 'brew-old', name: 'Stout', startedAt: Date.now() - 90 * DAY, stats: { abv: 6.1 } }),
          makeBrew({
            id: 'brew-1',
            name: 'Citra pale',
            style: 'American Pale Ale',
            startedAt: Date.now() - 30 * DAY,
            stats: { abv: 5.237 },
          }),
        ],
        'POST /api/kegs': makeKeg({ name: 'Citra pale (keg 2)', brewId: 'brew-1' }),
      },
    });
    expect(screen.getByText(/Nothing is kegged up here/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keg up' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Keg up' }));
    const pick = (await dialog.findByLabelText('Fill in from a brew')) as HTMLSelectElement;
    // Newest first.
    expect([...pick.options].map((o) => o.value)).toEqual(['', 'brew-1', 'brew-old']);
    fireEvent.change(pick, { target: { value: 'brew-1' } });
    expect((dialog.getByLabelText('Name') as HTMLInputElement).value).toBe('Citra pale');
    expect((dialog.getByLabelText('Style') as HTMLInputElement).value).toBe('American Pale Ale');
    expect((dialog.getByLabelText('ABV (%)') as HTMLInputElement).value).toBe('5.2');

    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Citra pale (keg 2)' } });
    fireEvent.submit(dialog.getByLabelText('Name').closest('form')!);
    await waitFor(() => expect(view.calls('POST /api/kegs')).toHaveLength(1));
    expect(view.calls('POST /api/kegs')[0]!.body).toEqual({
      pillId: 'laser-1',
      name: 'Citra pale (keg 2)',
      style: 'American Pale Ale',
      abv: 5.2,
      brewId: 'brew-1',
    });
    await waitFor(() => expect(toastTexts()).toContain('Citra pale (keg 2) kegged up: Cheers! 🍻'));
  });

  it('can be kegged up with nothing filled in, or earlier', async () => {
    const l = laser();
    const view = await renderWithHub(<KegPanel pill={l} />, {
      pills: [l],
      routes: { 'GET /api/kegs': [], 'GET /api/brews': [], 'POST /api/kegs': makeKeg({ name: '' }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Keg up' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Keg up' }));
    expect(dialog.queryByLabelText('Fill in from a brew')).toBeNull();
    fireEvent.click(dialog.getByLabelText(/It was kegged earlier/));
    fireEvent.change(dialog.getByLabelText('Kegged up at'), { target: { value: '2026-01-02T18:30' } });
    fireEvent.submit(dialog.getByLabelText('Name').closest('form')!);
    await waitFor(() => expect(view.calls('POST /api/kegs')).toHaveLength(1));
    expect(view.calls('POST /api/kegs')[0]!.body).toEqual({
      pillId: 'laser-1',
      name: '',
      style: '',
      abv: null,
      brewId: null,
      keggedAt: new Date('2026-01-02T18:30').getTime(),
    });
    await waitFor(() => expect(toastTexts()).toContain('Unnamed beer kegged up: Cheers! 🍻'));
  });

  it('warns that kegging up another beer empties the one on tap', async () => {
    const l = laser({ keg: makeKeg() });
    await renderWithHub(<KegModal pill={l} keg={null} onClose={() => {}} />, { pills: [l], routes: { 'GET /api/brews': [] } });
    expect(screen.getByText('Citra pale is still on tap: kegging up another beer marks it empty.')).toBeTruthy();
  });
});

describe('A kegged-up beer', () => {
  it('is shown on its card with how much is left and has been poured, in place of how full the keg is', async () => {
    await renderWithHub(<Dashboard />, { pills: [laser({ keg: makeKeg() })] });
    const c = within(card('Kegerator left'));
    expect(c.getByText('On tap')).toBeTruthy();
    expect(c.getByText('Citra pale')).toBeTruthy();
    expect(c.getByText('5.2% ABV')).toBeTruthy();
    expect(c.getByText('Kegged 19 L')).toBeTruthy();
    expect(c.getByText('9.5 L left')).toBeTruthy();
    expect(c.getByText('9.5 L poured')).toBeTruthy();
    expect(c.getByRole('meter', { name: 'How much of the beer is left' }).getAttribute('aria-valuenow')).toBe('50');
    expect(c.queryByText('In the keg')).toBeNull();
    expect(c.queryByRole('meter', { name: 'How full the keg is' })).toBeNull();
  });

  it('charts its card from when it was kegged, and a card with nothing on tap the last 24 hours', async () => {
    const keggedAt = Date.now() - 3 * DAY;
    const view = await renderWithHub(<Dashboard />, {
      pills: [laser({ keg: makeKeg({ keggedAt }), live: { firstReadingAt: Date.now() - 30 * DAY } })],
    });
    expect(Number(view.calls('GET /api/pills/*/history')[0]!.query.get('from'))).toBe(keggedAt);
    view.unmount();
    const empty = await renderWithHub(<Dashboard />, { pills: [laser({ live: { firstReadingAt: Date.now() - 30 * DAY } })] });
    const from = Number(empty.calls('GET /api/pills/*/history')[0]!.query.get('from'));
    expect(Date.now() - from).toBeGreaterThanOrEqual(DAY);
    expect(Date.now() - from).toBeLessThan(DAY + 16 * 60_000);
  });

  it('is in the compact row in place of "Keg"', async () => {
    await renderWithHub(<Dashboard />, { pills: [laser({ keg: makeKeg() })] });
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    const row = within(within(screen.getByRole('list', { name: 'Devices' })).getAllByRole('listitem')[0]!);
    expect(row.getByText(/Citra pale ·/)).toBeTruthy();
  });

  it('can be marked empty, and the earlier ones are listed', async () => {
    const l = laser({ keg: makeKeg() });
    const before = makeKeg({ id: 'keg-0', name: 'Stout', style: '', abv: 6.1, startVolume: 18.5, endedAt: Date.now() - 3 * DAY });
    const view = await renderWithHub(<KegPanel pill={l} />, {
      pills: [l],
      routes: { 'GET /api/kegs': [makeKeg(), before], 'POST /api/kegs/*/end': makeKeg({ endedAt: Date.now() }) },
    });
    expect(screen.getByRole('button', { name: 'Citra pale' }).getAttribute('aria-expanded')).toBe('true');
    const earlier = within(await screen.findByRole('list', { name: 'Earlier kegs' }));
    expect(earlier.getAllByRole('listitem')).toHaveLength(1);
    expect(earlier.getByText(/Kegged 18\.5 L · 6\.1% ABV/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keg empty' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Is "Citra pale" empty?' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Keg empty' }));
    await waitFor(() => expect(view.calls('POST /api/kegs/*/end')).toHaveLength(1));
    expect(view.calls('POST /api/kegs/*/end')[0]!.path).toBe('/api/kegs/keg-1/end');
  });

  it("leaves the time alone when it's edited but not moved", async () => {
    const l = laser({ keg: makeKeg({ keggedAt: Date.now() - DAY + 12_345 }) });
    const view = await renderWithHub(<KegPanel pill={l} />, {
      pills: [l],
      routes: { 'GET /api/kegs': [], 'GET /api/brews': [], 'PATCH /api/kegs/*': makeKeg({ abv: 5.4 }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit Citra pale' }));
    fireEvent.change(dialog.getByLabelText('ABV (%)'), { target: { value: '5.4' } });
    fireEvent.submit(dialog.getByLabelText('Name').closest('form')!);
    await waitFor(() => expect(view.calls('PATCH /api/kegs/*')).toHaveLength(1));
    expect(view.calls('PATCH /api/kegs/*')[0]!.body).toEqual({ name: 'Citra pale', style: 'American Pale Ale', abv: 5.4, brewId: null });
  });

  it('charts from when it was kegged, at first', async () => {
    const l = laser({ keg: makeKeg() });
    await renderWithHub(<PillPage id={l.id} />, { pills: [l], routes: { 'GET /api/kegs': [] } });
    expect(screen.getByRole('button', { name: 'Since it was kegged' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Since the brew started' })).toBeNull();
  });

  it("has no Kegged range when nothing's kegged up", async () => {
    const l = laser();
    await renderWithHub(<PillPage id={l.id} />, { pills: [l], routes: { 'GET /api/kegs': [] } });
    expect(screen.queryByRole('button', { name: 'Since it was kegged' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Last 24 hours' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Volume units', () => {
  it('are only offered once there is a Laser Level', async () => {
    await renderWithHub(<UnitToggles />, { pills: [makePill()] });
    expect(screen.queryByRole('combobox', { name: 'Volume unit' })).toBeNull();
  });

  it('show the keg in litres, gallons or pints (written out), picked in this browser', async () => {
    const view = await renderWithHub(
      <>
        <UnitToggles />
        <LaserCard pill={laser()} />
      </>,
      { pills: [laser()] },
    );
    const big = () => document.querySelector('.gravity-value')?.textContent;
    expect(big()).toBe('9.5of 19 L');
    const pick = screen.getByRole('combobox', { name: 'Volume unit' });
    fireEvent.change(pick, { target: { value: 'gal' } });
    expect(big()).toBe('2.5of 5 gal');
    fireEvent.change(pick, { target: { value: 'pint-uk' } });
    expect(big()).toBe('17of 33 pints');
    expect(localStorage.getItem(VOLUME_KEY)).toBe('pint-uk');

    const tapped = (startVolume: number) => (
      <>
        <UnitToggles />
        <LaserCard pill={laser({ keg: makeKeg({ startVolume }) })} />
      </>
    );
    view.rerender(tapped(9.5));
    expect(screen.getByText('17 pints left')).toBeTruthy();
    expect(screen.getByText('0 pints poured')).toBeTruthy();
    view.rerender(tapped(10));
    expect(screen.getByText('1 pint poured')).toBeTruthy();
  });

  it("use a Laser Level's own unit for Custom, or litres when it has none", async () => {
    const own = laser({ servingUnit: { ml: 330, name: 'cans' } });
    const view = await renderWithHub(
      <>
        <UnitToggles />
        <LaserCard pill={own} />
      </>,
      { pills: [own] },
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Volume unit' }), { target: { value: 'custom' } });
    expect(document.querySelector('.gravity-value')?.textContent).toBe('29of 58 cans');
    view.rerender(
      <>
        <UnitToggles />
        <LaserCard pill={laser()} />
      </>,
    );
    expect(document.querySelector('.gravity-value')?.textContent).toBe('9.5of 19 L');
  });

  it("set a Laser Level's own unit in its settings", async () => {
    const l = laser();
    const view = await renderWithHub(<PillSettings pill={l} />, {
      pills: [l],
      afterLoad: true,
      routes: { 'PATCH /api/pills/*': laser({ servingUnit: { ml: 330, name: 'cans' } }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Laser Level settings' }));
    const save = screen.getByRole('button', { name: 'Save unit' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Size (ml)'), { target: { value: '330' } });
    fireEvent.change(screen.getByLabelText('Called'), { target: { value: 'cans' } });
    expect(screen.getByText('Right now that’s 29 cans.')).toBeTruthy();
    fireEvent.submit(save.closest('form')!);
    await waitFor(() => expect(view.calls('PATCH /api/pills/*')).toHaveLength(1));
    expect(view.calls('PATCH /api/pills/*')[0]!.body).toEqual({ servingUnit: { ml: 330, name: 'cans' } });
  });
});
