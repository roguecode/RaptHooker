// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { IspindelInfo, IspindelSetupProgress } from '@rapthooker/shared';
import { makeBle, makeNearby, makePill, makeReading, renderWithHub, settle, toastTexts } from '../../test/render';
import { AddDeviceButton } from './AddDevice';

vi.mock('../settings/copy', () => ({ copyText: vi.fn(async () => true) }));

const INFO: IspindelInfo = {
  token: 'rh_ispindel_secret',
  server: { host: '192.168.1.20', hosts: ['192.168.1.20'], port: 8080, path: '/api/ispindel' },
  wifi: { canSetUp: true, reason: null, ssid: 'Brewery', channel: 6, goesOffline: true, knowsPassword: true },
  hotspots: [{ ssid: 'iSpindel', bssid: '42:91:51:64:98:3F', chipId: '64983F', signal: 90, channel: 1, seenAt: Date.now() }],
  scannedAt: Date.now(),
  setup: null,
};

const routes = (info: Partial<IspindelInfo> = {}) => ({
  'GET /api/ispindel': { ...INFO, ...info },
  'POST /api/ispindel/scan': { hotspots: info.hotspots ?? INFO.hotspots, scannedAt: Date.now() },
  'DELETE /api/ispindel/setup/*': null,
});

async function open(fake: Parameters<typeof renderWithHub>[1] = {}) {
  const view = await renderWithHub(<AddDeviceButton />, { routes: routes(), ...fake });
  fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
  await settle();
  return { view, dialog: screen.getByRole('dialog', { name: 'Add a device' }) };
}

function progress(over: Partial<IspindelSetupProgress> = {}): IspindelSetupProgress {
  const now = Date.now();
  return {
    id: 's1',
    hotspot: 'iSpindel',
    chipId: '64983F',
    step: 'hotspot',
    state: 'running',
    error: null,
    detail: null,
    deviceId: null,
    waiting: false,
    written: null,
    hubBack: true,
    startedAt: now - 3000,
    updatedAt: now,
    steps: [{ step: 'hotspot', at: now }],
    ...over,
  };
}

describe('Add device', () => {
  it('has a tab for each kind, opening on the one something was found for, and lists only that kind', async () => {
    const thermometer = makeNearby({ address: 'D0:26:25:B4:48:95', raptId: 'D0:26:25:B4:48:95', kind: 'thermometer' });
    const { dialog } = await open({ nearby: [thermometer] });
    const tabs = within(dialog).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringContaining('RAPT Pill'),
      expect.stringContaining('RAPT Thermometer'),
      expect.stringContaining('RAPT Laser Level'),
      expect.stringContaining('Tilt'),
      expect.stringContaining('iSpindel'),
    ]);
    // The ones not tried with a real device yet say so.
    expect(tabs.map((t) => t.textContent?.includes('experimental'))).toEqual([false, false, true, true, false]);
    expect(within(dialog).getByRole('tab', { selected: true }).textContent).toContain('RAPT Thermometer');
    expect(within(dialog).getByRole('heading', { name: 'Found a RAPT Thermometer nearby' })).toBeTruthy();

    // Arrow keys move between the tabs, as tabs do.
    fireEvent.keyDown(within(dialog).getByRole('tab', { selected: true }), { key: 'ArrowLeft' });
    expect(within(dialog).getByRole('tab', { selected: true }).textContent).toContain('RAPT Pill');
    expect(within(dialog).getByText('Listening for RAPT Pills…')).toBeTruthy();
    expect(within(dialog).queryByRole('heading', { name: 'Found a RAPT Thermometer nearby' })).toBeNull();
  });

  it('adds a pill found nearby, as the dashboard does, and closes', async () => {
    const nearby = makeNearby({ address: 'F0:0D:5E:ED:00:01', raptId: 'F0:0D:5E:ED:00:FF' });
    const added = makePill({ id: 'f00d5eed0001', name: 'Hazy' });
    const { view, dialog } = await open({ nearby: [nearby], routes: { ...routes(), 'POST /api/pills': added } });
    fireEvent.change(within(dialog).getByLabelText('Name for the pill F0:0D:5E:ED:00:FF (optional)'), { target: { value: 'Hazy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Add pill/ }));
    await settle();
    expect(view.calls('POST /api/pills')[0]!.body).toEqual({ address: 'F0:0D:5E:ED:00:01', name: 'Hazy' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toastTexts()).toContain('Hazy added: Recording has started.');
  });

  it('lists an iSpindel sending to the hub under its own name', async () => {
    const ispindel = makeNearby({
      address: 'ISPINDEL:64983F',
      raptId: 'ISPINDEL:64983F',
      kind: 'ispindel',
      name: '2-yolandi_[SG]',
      rssi: -55,
      latest: makeReading({ gravity: 1.0465, temperature: 19.5 }),
    });
    const { dialog } = await open({ nearby: [ispindel] });
    expect(within(dialog).getByRole('tab', { selected: true }).textContent).toContain('iSpindel');
    expect(within(dialog).getByRole('heading', { name: '2-yolandi_[SG] is sending to this hub' })).toBeTruthy();
    expect(within(dialog).getByText(/Wi-Fi: Excellent \(-55 dBm\)/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Add iSpindel/ })).toBeTruthy();
  });

  it('says Bluetooth devices are only heard through a relay while Bluetooth is off', async () => {
    const { dialog } = await open({ ble: makeBle({ state: 'off', offBy: 'settings', adapter: null, adapters: [] }) });
    expect(within(dialog).getByText('Bluetooth is switched off on this hub.')).toBeTruthy();
    expect(within(dialog).queryByText("Bluetooth isn't working.")).toBeNull();
  });
});

describe('Add device: iSpindel', () => {
  async function ispindelTab(fake: Parameters<typeof renderWithHub>[1] = {}) {
    const opened = await open(fake);
    fireEvent.click(within(opened.dialog).getByRole('tab', { name: /iSpindel/ }));
    await settle();
    return opened;
  }

  it('says what it does, finds the iSpindel in setup mode and sets it up, step by step', async () => {
    const pill = makePill({ id: 'ispindel-64983f', name: 'Fermenter 2', kind: 'ispindel', address: 'ISPINDEL:64983F' });
    const { view, dialog } = await ispindelTab({ routes: { ...routes(), 'POST /api/ispindel/setup': progress() } });
    // Looking for iSpindels in setup mode starts as soon as the tab is open.
    expect(view.calls('POST /api/ispindel/scan').length).toBeGreaterThan(0);
    const explain = within(dialog).getByText('What the hub does').closest('details')!;
    expect(explain.textContent).toContain('this hub, 192.168.1.20:8080');
    expect(explain.textContent).toContain('The hub is off your network meanwhile');
    expect(within(dialog).getByRole('radio', { name: /iSpindel · chip 64983F/ })).toBeTruthy();

    expect((within(dialog).getByLabelText('Wi-Fi for the iSpindel') as HTMLSelectElement).value).toBe('Brewery');
    fireEvent.change(within(dialog).getByLabelText('Name (optional)'), { target: { value: 'Fermenter 2' } });
    fireEvent.change(within(dialog).getByLabelText('Sends a reading'), { target: { value: '1800' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up iSpindel' }));
    await settle();
    expect(view.calls('POST /api/ispindel/setup')[0]!.body).toEqual({
      hotspot: 'iSpindel',
      ssid: 'Brewery',
      password: '',
      name: 'Fermenter 2',
      interval: 1800,
    });
    expect(within(dialog).getByText('Setting up iSpindel', { exact: false })).toBeTruthy();

    const written = { name: 'Fermenter 2', ssid: 'Brewery', server: '192.168.1.20', port: 8080, path: '/api/ispindel', interval: 1800 };
    await view.push({ type: 'ispindel-setup', setup: progress({ step: 'configure', written }) });
    expect(within(dialog).getByText('Saving the settings for this hub').closest('li')!.getAttribute('aria-current')).toBe('step');
    await view.push({ type: 'pill', pill });
    await view.push({
      type: 'ispindel-setup',
      setup: progress({ step: 'done', state: 'done', deviceId: pill.id, written }),
    });
    expect(within(dialog).getByText('Fermenter 2 is added', { exact: false })).toBeTruthy();
    expect(within(dialog).getByText('http://192.168.1.20:8080/api/ispindel')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Open Fermenter 2' }).getAttribute('href')).toBe('#/pill/ispindel-64983f');
    // The hub is told it's been shown, so it isn't shown again next time; another can be set up straight away.
    expect(view.calls('DELETE /api/ispindel/setup/s1')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up another' }));
    await settle();
    expect(within(dialog).queryByText('Fermenter 2 is added', { exact: false })).toBeNull();
    expect(within(dialog).getByRole('radio', { name: /iSpindel · chip 64983F/ })).toBeTruthy();
  });

  it('explains a set-up that ended without a reading, and one that failed', async () => {
    const { view, dialog } = await ispindelTab();
    await view.push({ type: 'ispindel-setup', setup: progress({ step: 'done', state: 'done', waiting: true }) });
    expect(within(dialog).getByText(/It hasn't sent a reading yet/)).toBeTruthy();
    await view.push({
      type: 'ispindel-setup',
      setup: progress({ step: 'read', state: 'failed', error: 'not-ispindel', updatedAt: Date.now() + 1 }),
    });
    expect(within(dialog).getByRole('alert').textContent).toContain("That hotspot's setup page isn't an iSpindel's.");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(within(dialog).getByRole('button', { name: 'Set up iSpindel' })).toBeTruthy();
  });

  it('gives every value to type by hand, with the token already made', async () => {
    const { dialog } = await ispindelTab();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set it up by hand' }));
    const values = within(dialog).getByText('Service Type').closest('dl')!;
    expect(values.textContent).toContain('HTTP');
    expect(values.textContent).toContain('rh_ispindel_secret');
    expect(values.textContent).toContain('192.168.1.20');
    expect(values.textContent).toContain('8080');
    expect(values.textContent).toContain('/api/ispindel');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy Token' }));
    await settle();
    expect(toastTexts()).toContain('Copied: Token');
    expect(within(dialog).getByText(/not a name like rapthooker.local/)).toBeTruthy();
  });

  it("falls back to setting it up by hand when the hub can't switch Wi-Fi, and shows no token to others", async () => {
    const { dialog } = await ispindelTab({
      session: { role: 'viewer' },
      routes: routes({ token: null, wifi: { ...INFO.wifi, canSetUp: false, reason: 'off' } }),
    });
    expect(within(dialog).getByText(/This hub can't switch Wi-Fi networks/)).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Set it up by hand' })[1]!);
    expect(within(dialog).getByText('Sign in as the owner to see it.')).toBeTruthy();
  });
});
