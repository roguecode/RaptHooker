// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BleStatus, Pill } from '@rapthooker/shared';

const live = vi.hoisted(() => ({ ble: null as BleStatus | null, pills: [] as Pill[] }));
vi.mock('../../live', () => ({ useLive: () => live }));

import { BluetoothSection } from './BluetoothSection';

const now = Date.now();
const status = (patch: Partial<BleStatus> = {}): BleStatus => ({
  state: 'scanning',
  adapter: 'hci0',
  adapters: ['hci0'],
  mode: 'passive',
  modeReason: null,
  error: null,
  lastAdvertAt: now - 30_000,
  since: now - 3_600_000,
  relays: [],
  ...patch,
});
const pill = (name: string, caught: Pill['live']['caught']): Pill =>
  ({
    id: name.toLowerCase(),
    name,
    color: '#8b5cf6',
    archived: false,
    live: { caught, lastReadingAt: caught ? now : null },
  }) as unknown as Pill;

afterEach(cleanup);

describe('BluetoothSection', () => {
  it('shows passive scanning, the adapters and how many readings were caught', () => {
    live.ble = status({ adapters: ['hci0', 'hci1'] });
    live.pills = [pill('Stout', { since: now - 24 * 3_600_000, expected: 700, received: 690 }), pill('Lager', null)];
    render(createElement(BluetoothSection));
    expect(screen.getAllByText('Passive').length).toBeGreaterThan(0);
    expect(screen.getByText(/only listens/)).toBeTruthy();
    expect(screen.getByText('hci0, hci1')).toBeTruthy();
    expect(screen.getByText('98%')).toBeTruthy();
    expect(screen.getByText(/690 readings of 700/)).toBeTruthy();
    expect(screen.getByText('No readings yet.')).toBeTruthy();
    expect(screen.queryByText(/Missing readings/)).toBeNull();
    expect(screen.getByText(/How to set one up/)).toBeTruthy();
  });

  it('explains active scanning, lists relays and suggests fixes when readings are missed', () => {
    live.ble = status({
      mode: 'active',
      modeReason: "BlueZ's experimental features are off",
      relays: [{ name: 'shed', lastAt: now - 60_000, adverts: 42 }],
    });
    live.pills = [pill('Stout', { since: now - 6 * 3_600_000, expected: 170, received: 100 })];
    render(createElement(BluetoothSection));
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getByText(/Why: BlueZ's experimental features are off/)).toBeTruthy();
    expect(screen.getByText('shed')).toBeTruthy();
    expect(screen.getByText(/42 adverts/)).toBeTruthy();
    expect(screen.getByText('58%')).toBeTruthy();
    expect(screen.getByText(/last 6 hours/)).toBeTruthy();
    expect(screen.getByText(/Missing readings/)).toBeTruthy();
  });

  it('says why it is not listening', () => {
    live.ble = status({ state: 'error', mode: null, adapters: [], error: 'No Bluetooth adapter found' });
    live.pills = [];
    render(createElement(BluetoothSection));
    expect(screen.getByText(/Not listening: No Bluetooth adapter found/)).toBeTruthy();
  });
});
