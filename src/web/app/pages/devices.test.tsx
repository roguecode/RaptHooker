// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VESSEL, type History } from '@rapthooker/shared';
import { emptyHistory, makeNearby, makePill, makeReading, renderWithHub, type FakeRequest } from '../test/render';
import { Dashboard } from './Dashboard';
import { Tiles } from './pill/Tiles';
import { PillSettings } from './pill/PillSettings';

const HOUR = 3_600_000;
const LASER = 'D8:3B:DA:44:55:66';
const TILT = 'A4:C1:38:11:22:33';

const noGravity = { gravity: null, pillGravity: null, velocity: null, pillVelocity: null, tilt: null, x: null, y: null, z: null };

/** A Laser Level on a 19 L keg, 293 mm down to the beer: half full. */
const laser = () =>
  makePill({
    id: 'laser-1',
    kind: 'laser-level',
    name: 'Pale ale keg',
    address: LASER,
    raptId: LASER,
    order: 1,
    vessel: DEFAULT_VESSEL,
    info: { firmware: '1.0', deviceType: 'RAPT Laser Level', payloadVersion: null },
    live: {
      latest: makeReading({ ...noGravity, temperature: 4, battery: 86, rssi: -61, distance: 293, fill: 50, volume: 9.5 }),
      rssi: -61,
      intervalSec: 60,
    },
  });

const tilt = () =>
  makePill({
    id: 'tilt-1',
    kind: 'tilt',
    name: 'Tilt Red',
    color: '#ef4444',
    address: TILT,
    raptId: TILT,
    order: 2,
    info: { firmware: null, deviceType: 'Tilt Red', payloadVersion: null },
    model: { velocitySource: 'computed' },
    live: { latest: makeReading({ gravity: 1.05, temperature: 20, battery: null, tilt: null, x: null, y: null, z: null }), rssi: -66 },
  });

/** The keg's last few hours: poured from twice. */
const kegHours = (req: FakeRequest): History => {
  const id = req.path.split('/')[3] ?? '';
  if (id !== 'laser-1') return emptyHistory(id);
  const now = Date.now();
  const ts = [now - 3 * HOUR, now - 2 * HOUR, now - HOUR];
  const nulls = ts.map(() => null);
  return {
    ...emptyHistory(id),
    ts,
    temperature: [4, 4.2, 4],
    rssi: [-61, -60, -61],
    gravity: nulls,
    velocity: nulls,
    battery: [86, 86, 86],
    tilt: nulls,
    implausible: ts.map(() => false),
    distance: [240, 266, 293],
  };
};

const card = (name: string) => screen.getByRole('link', { name }).closest('article')!;

describe('RAPT Laser Level on the dashboard', () => {
  it('has a card with how full its keg is, and nothing a pill measures', async () => {
    await renderWithHub(<Dashboard />, { pills: [makePill(), laser()], routes: { 'GET /api/pills/*/history': kegHours } });
    expect(screen.getByText('1 pill recording · 1 keg level recording')).toBeTruthy();
    const keg = within(card('Pale ale keg'));
    expect(card('Pale ale keg').querySelector('.gravity-value')?.textContent).toBe('9.5of 19 L');
    expect(keg.getByText('50%')).toBeTruthy();
    expect(keg.getByRole('meter', { name: 'How full the keg is' }).getAttribute('aria-valuenow')).toBe('50');
    expect(keg.getByText('86%')).toBeTruthy();
    expect(keg.getByText('293 mm')).toBeTruthy();
    expect(keg.queryByText('Gravity')).toBeNull();
    expect(keg.queryByText('Idle')).toBeNull();
  });

  it('has a compact row with its litres and how full it is', async () => {
    await renderWithHub(<Dashboard />, { pills: [makePill(), laser()] });
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    const rows = within(screen.getByRole('list', { name: 'Devices' })).getAllByRole('listitem');
    const keg = within(rows[1]!);
    expect(keg.getByText(/Keg/)).toBeTruthy();
    expect(keg.getByText('9.5 L')).toBeTruthy();
    expect(keg.getByText('50%')).toBeTruthy();
    expect(keg.queryByText('Gravity')).toBeNull();
  });

  it('adds one found nearby', async () => {
    const view = await renderWithHub(<Dashboard />, {
      pills: [makePill()],
      nearby: [
        makeNearby({
          address: LASER,
          raptId: LASER,
          kind: 'laser-level',
          latest: makeReading({ ...noGravity, temperature: 4, distance: 293, fill: 50, volume: 9.5 }),
        }),
      ],
      routes: { 'POST /api/pills': laser() },
    });
    const nearby = within(screen.getByRole('region', { name: 'Devices nearby' }));
    expect(nearby.getByRole('heading', { name: 'Found a RAPT Laser Level nearby' })).toBeTruthy();
    expect(nearby.getByText(/^D8:3B:DA:44:55:66 · 9\.5 L · 50% · Signal/)).toBeTruthy();
    fireEvent.click(nearby.getByRole('button', { name: 'Add Laser Level' }));
    await waitFor(() => expect(window.location.hash).toBe('#/pill/laser-1'));
    expect(view.calls('POST /api/pills')[0]!.body).toEqual({ address: LASER });
  });
});

describe("RAPT Laser Level's page", () => {
  it('shows the tiles a Laser Level has', async () => {
    const l = laser();
    await renderWithHub(<Tiles pill={l} now={Date.now()} />, { pills: [l] });
    const names = [...document.querySelectorAll('.tile .k')].map((k) => k.textContent?.trim());
    expect(names).toEqual([
      'In the keg',
      'Full',
      'Distance',
      'Temperature',
      'Battery',
      'Caught',
      'Signal',
      'Interval',
      'Last heard',
      'Firmware',
      'Bluetooth',
      'Recording since',
    ]);
    expect(screen.getByText('of 19 L')).toBeTruthy();
  });

  it('sets its keg up, from what it reads now if wanted', async () => {
    const l = laser();
    const view = await renderWithHub(<PillSettings pill={l} />, {
      pills: [l],
      afterLoad: true,
      routes: { 'PATCH /api/pills/*': { ...l, vessel: { capacity: 9.5, emptyMm: 293, fullMm: 26 } } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Laser Level settings' }));
    expect(screen.queryByLabelText(/^Gravity offset/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Calibration wizard' })).toBeNull();
    expect((screen.getByLabelText('Holds (litres)') as HTMLInputElement).value).toBe('19');
    expect(screen.getByText(/Right now it reads 293 mm/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save keg' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Holds (litres)'), { target: { value: '9.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'It’s empty now' }));
    expect((screen.getByLabelText('Empty: down to the bottom (mm)') as HTMLInputElement).value).toBe('293');
    // Empty can't be above full.
    fireEvent.change(screen.getByLabelText('Full: down to the beer (mm)'), { target: { value: '400' } });
    expect(screen.getByRole('alert').textContent).toContain('further down than full');
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Full: down to the beer (mm)'), { target: { value: '26' } });
    expect(save.disabled).toBe(false);
    fireEvent.submit(save.closest('form')!);
    await waitFor(() => expect(view.calls('PATCH /api/pills/*')).toHaveLength(1));
    expect(view.calls('PATCH /api/pills/*')[0]!.body).toEqual({ vessel: { capacity: 9.5, emptyMm: 293, fullMm: 26 } });
    expect(screen.getByRole('button', { name: 'Remove Laser Level' })).toBeTruthy();
  });
});

describe('Tilt', () => {
  it("has a pill's card, with its colour where the battery and tilt would be", async () => {
    await renderWithHub(<Dashboard />, { pills: [makePill(), tilt()] });
    const red = within(card('Tilt Red'));
    expect(red.getByText('Gravity')).toBeTruthy();
    expect(red.queryByText('Battery')).toBeNull();
    expect(red.getByText('Red')).toBeTruthy();
  });

  it('shows the tiles a Tilt has, and no tilt calibration', async () => {
    const t = tilt();
    await renderWithHub(<Tiles pill={t} now={Date.now()} />, { pills: [t] });
    const names = [...document.querySelectorAll('.tile .k')].map((k) => k.textContent?.trim());
    expect(names).not.toContain('Battery');
    expect(names).not.toContain('Tilt');
    expect(names).not.toContain('Accelerometer');
    expect(names).not.toContain('Firmware');
    // Its gravity is the Tilt's own.
    expect(names).toContain('GravityTilt');
    expect(screen.getByText('Tilt Red')).toBeTruthy();
  });

  it('has a gravity offset, but no gravity from a tilt it doesn’t send', async () => {
    const t = tilt();
    await renderWithHub(<PillSettings pill={t} />, { pills: [t], afterLoad: true });
    fireEvent.click(screen.getByRole('button', { name: 'Tilt settings' }));
    expect(screen.getByLabelText(/^Gravity offset/)).toBeTruthy();
    expect(screen.getByText(/A Tilt's own calibration/)).toBeTruthy();
    expect(screen.queryByText('Worked out by RaptHooker from the tilt')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Tilt' })).toBeTruthy();
  });
});
