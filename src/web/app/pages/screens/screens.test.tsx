// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SCREEN_SETUP_STEPS, type FoundScreen, type ScreenSetupProgress, type WifiNetwork, type WifiStatus } from '@rapthooker/shared';
import { makePill, makeScreen, renderWithHub, settle, toastTexts, type FakeRequest } from '../../test/render';
import { ImageLinkButton } from '../../components/ImageLink';
import { ScreensPage } from './ScreensPage';
import { ScreenChips } from './ScreenCard';

const picture = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'Content-Type': 'image/jpeg' } });

const WIFI: WifiStatus = { canSetUp: true, reason: null, ssid: 'Brewery', channel: 6, goesOffline: true, knowsPassword: true };
const NETS: WifiNetwork[] = [
  { ssid: 'Brewery', bssid: 'aa', signal: 80, channel: 6, band: 2.4, secure: true, kind: null, current: true },
  { ssid: 'Smart weather clock', bssid: 'bb', signal: 70, channel: 1, band: 2.4, secure: false, kind: 'sdpro', current: false },
  { ssid: 'Neighbours', bssid: 'cc', signal: 30, channel: 11, band: 2.4, secure: true, kind: null, current: false },
];

function progress(over: Partial<ScreenSetupProgress> = {}): ScreenSetupProgress {
  const now = Date.now();
  return {
    id: 'setup-1',
    hotspot: 'Smart weather clock',
    step: 'hotspot',
    state: 'running',
    error: null,
    detail: null,
    screenId: null,
    hubBack: true,
    startedAt: now - 5000,
    updatedAt: now,
    steps: [{ step: 'hotspot', at: now }],
    ...over,
  };
}

const reached = (upTo: ScreenSetupProgress['step']) =>
  SCREEN_SETUP_STEPS.slice(0, SCREEN_SETUP_STEPS.indexOf(upTo) + 1).map((step) => ({ step, at: Date.now() }));

const BASE = {
  'GET /api/screens/setup': null,
  'GET /api/screens/found': [],
  'GET /api/screens/*/image.jpg': picture,
  'GET /api/image.jpg': picture,
};

const step = (label: string) => screen.getByText(label).closest('li')!;

describe('screens page', () => {
  it('lists the screens and installs new firmware on all of them', async () => {
    const pill = makePill();
    const a = makeScreen({ status: { update: '1.1.0' } });
    const b = makeScreen({ id: '025248000002', name: 'Bar', pillId: pill.id, status: { state: 'offline', update: '1.1.0' } });
    const view = await renderWithHub(<ScreensPage />, {
      pills: [pill],
      screens: [a, b],
      routes: { ...BASE, 'POST /api/screens/update-all': { updated: [a.id], failed: [b.id] } },
    });
    expect(screen.getByRole('heading', { name: 'Kitchen' })).toBeTruthy();
    expect(screen.getByText(/All pills · every 1 min/)).toBeTruthy();
    expect(screen.getByText(`${pill.name} · every 1 min`, { exact: false })).toBeTruthy();
    expect(screen.getAllByText('Offline').length).toBeGreaterThan(0);

    expect(screen.getByText(/2 screens can be updated/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update all' }));
    await settle();
    expect(view.calls('POST /api/screens/update-all')).toHaveLength(1);
    expect(toastTexts()).toEqual(expect.arrayContaining(['Updated 1 screen', "Couldn't update Bar: They keep the firmware they had."]));

    // The hub says how each one is doing as it goes.
    await view.push({ type: 'screen', screen: { ...a, firmware: '1.1.0', status: { ...a.status, update: null } } });
    await view.push({ type: 'screen', screen: { ...b, firmware: '1.1.0', status: { ...b.status, update: null } } });
    expect(screen.queryByText(/can be updated/)).toBeNull();
    await view.push({ type: 'screen-removed', screenId: b.id });
    expect(screen.queryByRole('heading', { name: 'Bar' })).toBeNull();
  });

  it('sets a screen up through the hub, and follows it to the end', async () => {
    const pill = makePill();
    const view = await renderWithHub(<ScreensPage />, {
      pills: [pill],
      routes: { ...BASE, 'GET /api/screens/wifi': WIFI, 'POST /api/screens/wifi/scan': NETS, 'POST /api/screens/setup': () => progress() },
    });
    expect(screen.getByRole('heading', { name: 'No screens yet' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });

    // The screen's own network is picked out from the rest.
    const row = (await within(dialog).findByText('Smart weather clock')).closest('li')!;
    expect(row.className).toContain('likely');
    expect(within(dialog).getByText('1 other network')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Set up' }));

    // The hub's own network, with the password it has.
    const ssid = within(dialog).getByRole('combobox', { name: 'Wi-Fi for the screen' }) as HTMLSelectElement;
    expect(ssid.value).toBe('Brewery');
    expect(within(dialog).getByText(/Leave the password empty to use the one the hub has/)).toBeTruthy();
    expect(within(dialog).getByText(/off your network for a minute or two/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Kitchen' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'It shows' }), { target: { value: pill.id } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set it up' }));
    await settle();
    const sent = view.calls('POST /api/screens/setup')[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ hotspot: 'Smart weather clock', ssid: 'Brewery', password: '', name: 'Kitchen', pillId: pill.id });
    expect(sent.look).toMatchObject({ gravity: 'sg', temperature: 'C' });
    expect(screen.queryByRole('dialog')).toBeNull();

    // Progress, live.
    expect(screen.getByRole('heading', { name: 'Setting up a screen' })).toBeTruthy();
    await view.push({ type: 'screen-setup', setup: progress({ step: 'install', steps: reached('install') }) });
    expect(step('Installing RaptHooker firmware').getAttribute('aria-current')).toBe('step');
    expect(step('Checking the screen').className).toBe('done');
    expect((screen.getAllByRole('button', { name: 'Add a screen' })[0] as HTMLButtonElement).disabled).toBe(true);

    const added = makeScreen();
    await view.push({ type: 'screen', screen: added });
    await view.push({ type: 'screen-setup', setup: progress({ state: 'done', step: 'done', screenId: added.id, steps: reached('done') }) });
    expect(screen.getByRole('heading', { name: 'Kitchen is set up' })).toBeTruthy();
    expect(screen.getAllByText('192.168.1.50').length).toBeGreaterThan(0);
    expect(screen.getAllByText('02:52:48:00:00:01').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('heading', { name: 'Kitchen is set up' })).toBeNull();
  });

  it('picks a set-up back up when the hub comes back, and explains what went wrong', async () => {
    let now = progress({ step: 'wifi', steps: [...reached('hotspot'), { step: 'screen', at: 1 }, { step: 'wifi', at: 2 }] });
    const view = await renderWithHub(<ScreensPage />, {
      routes: { ...BASE, 'GET /api/screens/setup': () => now, 'GET /api/screens/wifi': WIFI, 'POST /api/screens/wifi/scan': NETS },
    });
    expect(step('Connecting the screen to your Wi-Fi').getAttribute('aria-current')).toBe('step');
    // A screen that already had RaptHooker skips installing it.
    expect(step('Installing RaptHooker firmware').className).toBe('skipped');

    // The hub was away (on the screen's Wi-Fi): back, it says how it went.
    now = progress({ state: 'failed', step: 'wifi', error: 'wrong-password', detail: 'wrong password', steps: now.steps });
    await view.reconnect();
    expect(screen.getByRole('heading', { name: "Setting up the screen didn't work" })).toBeTruthy();
    expect(screen.getByText("The screen couldn't join: the Wi-Fi password is wrong.")).toBeTruthy();
    expect(step('Connecting the screen to your Wi-Fi').className).toBe('failed');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Add a screen' })).toBeTruthy();
  });

  it("sets a screen up from the browser when the hub can't switch Wi-Fi", async () => {
    const firmware = new Uint8Array(64).fill(0xff);
    firmware[0] = 0xe9;
    const info = {
      firmware: 'rapthooker-screen',
      version: '1.0.0',
      model: 'sdpro-240',
      id: '025248000001',
      mac: '02:52:48:00:00:01',
      claimed: false,
    };
    const view = await renderWithHub(<ScreensPage />, {
      routes: {
        ...BASE,
        'GET /api/screens/wifi': { ...WIFI, canSetUp: false, reason: 'no-networkmanager', ssid: null, goesOffline: false },
        'POST /api/screens/manual': {
          pending: 'p1',
          token: 'secret-token-for-the-screen',
          hub: 'hub-1',
          imageBase: 'http://192.168.1.20:8080/api/screens/',
          firmware: [{ model: 'sdpro-240', version: '1.0.0', size: firmware.length, md5: 'x' }],
        },
        'GET /api/screens/firmware/*': () => new Response(firmware),
        // The screen, at 192.168.4.1 once this device is on its Wi-Fi (the fake hub only goes by the path).
        'GET /api/info': info,
        'GET /api/scan': { networks: [{ ssid: 'Brewery', channel: 6, rssi: -50 }] },
        'POST /api/setup': { ok: true, trial: 'testing' },
        'GET /api/setup': { trial: 'connected', error: '', ip: '192.168.1.50', saved: true },
        'POST /api/setup/finish': { ok: true },
        'POST /api/screens/manual/done': () => makeScreen(),
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });
    expect(await within(dialog).findByText(/doesn't use NetworkManager/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Wi-Fi for the screen' }), { target: { value: 'Brewery' } });
    fireEvent.change(within(dialog).getByLabelText('Wi-Fi password'), { target: { value: 'hops-and-barley' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: "I've joined it" }));

    await waitFor(() => expect(within(dialog).getByText(/Kitchen is set up|Screen is set up/)).toBeTruthy(), { timeout: 8000 });
    const setup = view.calls('POST /api/setup')[0]!;
    expect(setup.body).toMatchObject({
      ssid: 'Brewery',
      password: 'hops-and-barley',
      token: 'secret-token-for-the-screen',
      hub: 'hub-1',
      imageUrl: 'http://192.168.1.20:8080/api/screens/025248000001/image.jpg',
      channel: 6,
    });
    expect(view.calls('POST /api/screens/manual/done')[0]!.body).toEqual({
      pending: 'p1',
      id: info.id,
      model: 'sdpro-240',
      ip: '192.168.1.50',
    });
  }, 15_000);

  it('adds a screen found on the network with the code it shows', async () => {
    const found: FoundScreen = {
      id: '025248000009',
      model: 'sdpro-240',
      firmware: '1.0.0',
      api: 1,
      ip: '192.168.1.60',
      hostname: 'rh-screen-000009',
      claimed: true,
    };
    const adopt = (req: FakeRequest) => {
      const { code } = req.body as { code?: string };
      if (!code) return { screen: null, needsCode: true };
      if (code !== '123456') return new Response(JSON.stringify({ error: 'wrong-code' }), { status: 403 });
      return { screen: makeScreen({ id: found.id, name: 'Screen' }), needsCode: false };
    };
    const view = await renderWithHub(<ScreensPage />, {
      routes: { ...BASE, 'GET /api/screens/found': [found], 'POST /api/screens/adopt': adopt },
    });
    const panel = await screen.findByRole('region', { name: 'Screens found on your network' });
    expect(within(panel).getByText(/set up by another hub/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    const code = await within(panel).findByLabelText('The code on the screen');
    fireEvent.change(code, { target: { value: '111111' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    await settle();
    expect(toastTexts()).toContain("That code isn't the one on the screen");
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    await settle();
    expect(view.calls('POST /api/screens/adopt').map((r) => (r.body as { code?: string }).code)).toEqual([undefined, '111111', '123456']);
    expect(toastTexts()).toContain('Screen added');
  });

  it("changes what a screen shows, with the image link's choices", async () => {
    const pill = makePill();
    const s = makeScreen();
    const view = await renderWithHub(<ScreensPage />, {
      pills: [pill],
      screens: [s],
      routes: {
        ...BASE,
        'GET /api/pills/*/image.jpg': picture,
        'PATCH /api/screens/*': (req: FakeRequest) => ({ ...s, ...(req.body as object) }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Kitchen' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'It shows' }), { target: { value: pill.id } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Big numbers' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Light' }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'New picture every' }), { target: { value: '300' } });
    // The preview is the picture as it will be, at the screen's size.
    await waitFor(() => expect(view.calls('GET /api/pills/*/image.jpg').length).toBeGreaterThan(0), { timeout: 3000 });
    expect(Object.fromEntries(view.calls('GET /api/pills/*/image.jpg').at(-1)!.query)).toMatchObject({
      w: '240',
      h: '240',
      theme: 'light',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(view.calls('PATCH /api/screens/*')[0]!.body).toMatchObject({
      pillId: pill.id,
      interval: 300,
      look: { show: ['gravity', 'temperature'], theme: 'light' },
    });
    expect(toastTexts()).toContain('Kitchen saved');
  });

  it("doesn't offer changes to someone who isn't the owner", async () => {
    await renderWithHub(<ScreensPage />, {
      session: { role: 'viewer' },
      screens: [makeScreen({ status: { update: '1.1.0' } })],
      routes: BASE,
    });
    expect(screen.getByRole('heading', { name: 'Kitchen' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a screen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText(/can be updated/)).toBeNull();
  });
});

describe('screens with the pills they show', () => {
  it("shows a pill's screens, which open their settings", async () => {
    const pill = makePill();
    await renderWithHub(<ScreenChips pillId={pill.id} />, {
      pills: [pill],
      screens: [makeScreen({ pillId: pill.id }), makeScreen({ id: '025248000002', name: 'Bar' })],
      routes: BASE,
    });
    expect(screen.queryByRole('button', { name: /Bar/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Kitchen/ }));
    expect(screen.getByRole('dialog', { name: 'Kitchen' })).toBeTruthy();
  });

  it("sends an image link's picture to a screen", async () => {
    const pill = makePill();
    const s = makeScreen();
    const view = await renderWithHub(<ImageLinkButton pill={pill} />, {
      pills: [pill],
      screens: [s],
      routes: {
        ...BASE,
        'GET /api/system/addresses': [],
        'GET /api/pills/*/image.*': picture,
        'PATCH /api/screens/*': { ...s, pillId: pill.id },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Image link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show it on Kitchen' }));
    await settle();
    expect(view.calls('PATCH /api/screens/*')[0]!.body).toMatchObject({
      pillId: pill.id,
      look: { theme: 'light', show: expect.any(Array) },
    });
    expect(toastTexts()).toContain('Kitchen shows this now');
  });
});
