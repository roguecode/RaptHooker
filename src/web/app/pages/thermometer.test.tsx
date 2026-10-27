// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { History } from '@rapthooker/shared';
import { emptyHistory, makeNearby, makePill, makeReading, renderWithHub, type FakeRequest } from '../test/render';
import { Dashboard } from './Dashboard';
import { Tiles } from './pill/Tiles';
import { PillSettings } from './pill/PillSettings';

const HOUR = 3_600_000;
const ADDR = 'D0:26:25:B4:48:95';

const tempOnly = {
  gravity: null,
  pillGravity: null,
  velocity: null,
  pillVelocity: null,
  battery: null,
  tilt: null,
  x: null,
  y: null,
  z: null,
};

const thermometer = () =>
  makePill({
    id: 'thermo-1',
    kind: 'thermometer',
    name: 'Brew fridge',
    address: ADDR,
    raptId: ADDR,
    order: 1,
    info: { firmware: null, deviceType: null, payloadVersion: null },
    live: { latest: makeReading({ ...tempOnly, temperature: 15.3, rssi: -48 }), rssi: -48, intervalSec: 60 },
  });

/** The last day of the thermometer: 14.8 to 15.6 °C. */
const fridgeDay = (req: FakeRequest): History => {
  const id = req.path.split('/')[3] ?? '';
  if (id !== 'thermo-1') return emptyHistory(id);
  const now = Date.now();
  const ts = [now - 3 * HOUR, now - 2 * HOUR, now - HOUR];
  const nulls = ts.map(() => null);
  return {
    ...emptyHistory(id),
    ts,
    temperature: [14.8, 15.6, 15.3],
    rssi: [-48, -50, -49],
    gravity: nulls,
    velocity: nulls,
    battery: nulls,
    tilt: nulls,
    implausible: ts.map(() => false),
  };
};

const card = (name: string) => screen.getByRole('link', { name }).closest('article')!;

describe('RAPT Thermometer on the dashboard', () => {
  it('has a card with its temperature, its day and its signal, but nothing a pill measures', async () => {
    await renderWithHub(<Dashboard />, { pills: [makePill(), thermometer()], routes: { 'GET /api/pills/*/history': fridgeDay } });

    expect(screen.getByText('1 pill recording · 1 thermometer recording')).toBeTruthy();
    const fridge = within(card('Brew fridge'));
    expect(card('Brew fridge').querySelector('.gravity-value')?.textContent).toBe('15.3°C');
    expect(fridge.getByText('Thermometer')).toBeTruthy();
    expect(fridge.queryByText('Gravity')).toBeNull();
    expect(fridge.queryByText('Battery')).toBeNull();
    expect(fridge.queryByText('Idle')).toBeNull();
    expect(fridge.getByText('Excellent')).toBeTruthy();
    await waitFor(() => expect(fridge.getByText('14.8–15.6 °C')).toBeTruthy());
    // The pill's card is as before.
    expect(within(card('Hazy IPA')).getByText('Gravity')).toBeTruthy();
  });

  it('has a compact row with its temperature and signal', async () => {
    await renderWithHub(<Dashboard />, { pills: [makePill(), thermometer()] });
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    const rows = within(screen.getByRole('list', { name: 'Pills' })).getAllByRole('listitem');
    const fridge = within(rows[1]!);
    expect(fridge.getByText(/Thermometer/)).toBeTruthy();
    expect(fridge.getByText('15.3 °C')).toBeTruthy();
    expect(fridge.getByText('Excellent')).toBeTruthy();
    expect(fridge.queryByText('Gravity')).toBeNull();
    expect(fridge.queryByText('Battery')).toBeNull();
  });

  it('adds one found nearby', async () => {
    const added = thermometer();
    const view = await renderWithHub(<Dashboard />, {
      pills: [makePill()],
      nearby: [makeNearby({ address: ADDR, raptId: ADDR, kind: 'thermometer', latest: makeReading({ ...tempOnly, temperature: 15.3 }) })],
      routes: { 'POST /api/pills': added },
    });
    const nearby = within(screen.getByRole('region', { name: 'Pills nearby' }));
    expect(nearby.getByRole('heading', { name: 'Found a RAPT Thermometer nearby' })).toBeTruthy();
    expect(nearby.getByText(/^D0:26:25:B4:48:95 · 15\.3 °C · Signal: Good \(-70 dBm\)/)).toBeTruthy();

    fireEvent.change(nearby.getByRole('textbox', { name: /Name for the thermometer/ }), { target: { value: 'Brew fridge' } });
    fireEvent.click(nearby.getByRole('button', { name: 'Add thermometer' }));
    await waitFor(() => expect(window.location.hash).toBe('#/pill/thermo-1'));
    expect(view.calls('POST /api/pills')[0]!.body).toEqual({ address: ADDR, name: 'Brew fridge' });
  });
});

describe("RAPT Thermometer's page", () => {
  it('shows only the tiles a thermometer has', async () => {
    const t = thermometer();
    await renderWithHub(<Tiles pill={t} now={Date.now()} />, { pills: [t] });
    const names = [...document.querySelectorAll('.tile .k')].map((k) => k.textContent?.trim());
    expect(names).toEqual(['Temperature', 'Caught', 'Signal', 'Interval', 'Last heard', 'Bluetooth', 'Recording since']);
    const temp = [...document.querySelectorAll<HTMLElement>('.tile')][0]!;
    expect(temp.querySelector('.v')?.textContent).toBe('15.3 °C');
    expect(screen.getByText('RAPT Thermometer')).toBeTruthy();
    expect(screen.queryByText(/RAPT ID/)).toBeNull();
  });

  it('only has a temperature offset to set', async () => {
    const t = thermometer();
    await renderWithHub(<PillSettings pill={t} />, { pills: [t], afterLoad: true });
    expect(screen.getByRole('heading', { name: 'Thermometer settings' })).toBeTruthy();
    // The settings start folded.
    fireEvent.click(screen.getByRole('button', { name: 'Thermometer settings' }));
    expect(screen.getByLabelText(/^Temperature offset/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Gravity offset/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Calibration wizard' })).toBeNull();
    expect(screen.getByText('Added to every reading, including history and webhooks.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove thermometer' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/archive the thermometer instead/)).toBeTruthy();
    expect(dialog.getByText('all of its readings')).toBeTruthy();
  });
});
