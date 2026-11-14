// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  SCREEN_SETUP_STEPS,
  SCREEN_USB_STEPS,
  type FoundScreen,
  type ScreenSetupProgress,
  type UsbStatus,
  type WifiNetwork,
  type WifiStatus,
} from '@rapthooker/shared';
import { makePill, makeScreen, renderWithHub, settle, toastTexts, type FakeRequest } from '../../test/render';
import { ImageLinkButton } from '../../components/ImageLink';
import { ScreensPage } from './ScreensPage';
import { ScreenChips } from './ScreenCard';
import { geekmagicScreen } from './BrowserSetup';

const picture = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'Content-Type': 'image/jpeg' } });

const WIFI: WifiStatus = { canSetUp: true, reason: null, ssid: 'Brewery', channel: 6, band: 2.4, goesOffline: true, knowsPassword: true };
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

  it('sets a GeekMagic Ultra up from its hotspot', async () => {
    const giftv: WifiNetwork = {
      ssid: 'GIFTV',
      bssid: 'dd',
      signal: 75,
      channel: 1,
      band: 2.4,
      secure: false,
      kind: 'geekmagic',
      current: false,
    };
    const view = await renderWithHub(<ScreensPage />, {
      routes: {
        ...BASE,
        'GET /api/screens/wifi': WIFI,
        'POST /api/screens/wifi/scan': [...NETS, giftv],
        'POST /api/screens/setup': () => progress({ hotspot: 'GIFTV' }),
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });
    const row = (await within(dialog).findByText('GIFTV')).closest('li')!;
    expect(row.className).toContain('likely');
    expect(within(row).getByText(/GeekMagic Ultra, as it came/)).toBeTruthy();
    // The Smart weather clock's row doesn't mention GeekMagic.
    expect(
      within(within(dialog).getByText('Smart weather clock').closest('li')!).getByText(/^Smart weather clock, as it came/),
    ).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Set up' }));
    expect(within(dialog).queryByText(/Untested/)).toBeNull();
    expect(within(dialog).getByText(/RaptHooker puts its own firmware on the screen/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set it up' }));
    await settle();
    expect(view.calls('POST /api/screens/setup')[0]!.body).toMatchObject({ hotspot: 'GIFTV', ssid: 'Brewery' });
  });

  it("sets a GeekMagic Ultra that's on the network up from its address", async () => {
    const view = await renderWithHub(<ScreensPage />, {
      routes: {
        ...BASE,
        'GET /api/screens/wifi': WIFI,
        'POST /api/screens/wifi/scan': NETS,
        'POST /api/screens/setup': () => progress({ hotspot: '192.168.1.77', step: 'identify', steps: [{ step: 'identify', at: 1 }] }),
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });
    await within(dialog).findByText('Smart weather clock');
    const byAddress = within(dialog).getByText('A GeekMagic Ultra already on your Wi-Fi?').closest('details')!;
    fireEvent.click(within(byAddress).getByText('A GeekMagic Ultra already on your Wi-Fi?'));
    const go = within(byAddress).getByRole('button', { name: 'Set up' }) as HTMLButtonElement;
    const address = within(byAddress).getByRole('textbox', { name: "The screen's address" });
    fireEvent.change(address, { target: { value: '192.168.1.77/update' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(address, { target: { value: ' http://192.168.1.77/ ' } });
    fireEvent.click(go);

    expect(within(dialog).getByText('192.168.1.77')).toBeTruthy();
    expect(within(dialog).getByText('A GeekMagic Ultra on your network')).toBeTruthy();
    expect(within(dialog).queryByText(/Untested/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set it up' }));
    await settle();
    expect(view.calls('POST /api/screens/setup')[0]!.body).toMatchObject({ hotspot: '', address: '192.168.1.77', ssid: 'Brewery' });
    // There was no hotspot to join: that step isn't needed.
    expect(step("Joining the screen's Wi-Fi").className).toBe('skipped');
    expect(step('Checking the screen').getAttribute('aria-current')).toBe('step');
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

  it("stops a browser set-up on a board that can't keep its settings, and says how to put that right", async () => {
    const firmware = new Uint8Array(64).fill(0xff);
    firmware[0] = 0xe9;
    // RaptHooker put on an ESP32 board as an update over ESPHome: a set-up it couldn't save left it saying it's claimed.
    const info = {
      firmware: 'rapthooker-screen',
      version: '1.1.1',
      model: 'esp32-2432s028',
      id: 'e465b80fda54',
      mac: 'E4:65:B8:0F:DA:54',
      claimed: true,
      system: { sketchMd5: 'x', store: false },
    };
    const view = await renderWithHub(<ScreensPage />, {
      routes: {
        ...BASE,
        'GET /api/screens/wifi': { ...WIFI, canSetUp: false, reason: 'no-networkmanager', ssid: null, goesOffline: false },
        'POST /api/screens/manual': {
          pending: 'p1',
          token: 'secret-token-for-the-screen',
          hub: 'hub-1',
          imageBase: null,
          firmware: [{ model: 'sdpro-240', version: '1.0.0', size: firmware.length, md5: 'x' }],
        },
        'GET /api/screens/firmware/*': () => new Response(firmware),
        'GET /api/info': info,
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Wi-Fi for the screen' }), { target: { value: 'Brewery' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: "I've joined it" }));

    expect(await within(dialog).findByText(/This board can't keep its settings/)).toBeTruthy();
    expect(within(dialog).queryByText(/belongs to another hub/)).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'How to install it over USB' }).getAttribute('href')).toMatch(
      /rapthooker-screens\.md#an-esp32-board-from-a-computer$/,
    );
    expect(view.calls('POST /api/setup')).toEqual([]);
    expect(view.calls('POST /api/screens/manual/done')).toEqual([]);
  });

  it('has the hub put RaptHooker on a GeekMagic Ultra on the network, then finishes on its hotspot', async () => {
    const firmware = new Uint8Array(64).fill(0xff);
    firmware[0] = 0xe9;
    const fw = { model: 'sdpro-240', version: '1.0.0', size: firmware.length, md5: 'x' };
    const view = await renderWithHub(<ScreensPage />, {
      routes: {
        ...BASE,
        'GET /api/screens/wifi': { ...WIFI, canSetUp: false, reason: 'no-networkmanager', ssid: null, goesOffline: false },
        'POST /api/screens/manual': { pending: 'p1', token: 't', hub: 'hub-1', imageBase: null, firmware: [fw] },
        'GET /api/screens/firmware/*': () => new Response(firmware),
        'POST /api/screens/install': { found: { model: 'SmallTV-Ultra', version: 'Ultra-V9.0.50' }, firmware: fw, confirmed: true },
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Wi-Fi for the screen' }), { target: { value: 'Brewery' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByText(/"GIFTV" on a GeekMagic Ultra/)).toBeTruthy();
    fireEvent.click(within(dialog).getByText('A GeekMagic Ultra already on your Wi-Fi?'));
    fireEvent.change(within(dialog).getByRole('textbox', { name: "The screen's address" }), { target: { value: '192.168.1.77' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install RaptHooker' }));
    expect(
      await within(dialog).findByText(/The screen is restarting with RaptHooker. When the network "RaptHooker-Screen-…" appears/),
    ).toBeTruthy();
    expect(view.calls('POST /api/screens/install')[0]!.body).toEqual({ address: '192.168.1.77' });
  });

  it("says when the hub couldn't put RaptHooker on what's at an address", async () => {
    const firmware = new Uint8Array(64).fill(0xff);
    firmware[0] = 0xe9;
    await renderWithHub(<ScreensPage />, {
      routes: {
        ...BASE,
        'GET /api/screens/wifi': { ...WIFI, canSetUp: false, reason: 'no-networkmanager', ssid: null, goesOffline: false },
        'POST /api/screens/manual': {
          pending: 'p1',
          token: 't',
          hub: 'hub-1',
          imageBase: null,
          firmware: [{ model: 'sdpro-240', version: '1.0.0', size: firmware.length, md5: 'x' }],
        },
        'GET /api/screens/firmware/*': () => new Response(firmware),
        'POST /api/screens/install': () =>
          new Response(JSON.stringify({ error: 'This is a GeekMagic SmallTV-Pro: RaptHooker only knows the SmallTV-Ultra' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Wi-Fi for the screen' }), { target: { value: 'Brewery' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.click(await within(dialog).findByText('A GeekMagic Ultra already on your Wi-Fi?'));
    fireEvent.change(within(dialog).getByRole('textbox', { name: "The screen's address" }), { target: { value: '192.168.1.78' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install RaptHooker' }));
    expect(await within(dialog).findByText("Couldn't put RaptHooker on the screen")).toBeTruthy();
    expect(within(dialog).getByText(/SmallTV-Pro/)).toBeTruthy();
    // Back to joining the screen's Wi-Fi, or trying another address.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(within(dialog).getByRole('button', { name: "I've joined it" })).toBeTruthy();
  });

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

  it("says why a board found on the network that can't keep its settings can't be added", async () => {
    const found: FoundScreen = {
      id: 'e465b80fda54',
      model: 'esp32-2432s028',
      firmware: '1.1.1',
      api: 1,
      ip: '192.168.10.91',
      hostname: 'rh-screen-0fda54',
      claimed: true,
    };
    await renderWithHub(<ScreensPage />, {
      routes: {
        ...BASE,
        'GET /api/screens/found': [found],
        'POST /api/screens/adopt': () => new Response(JSON.stringify({ error: 'no-store' }), { status: 409 }),
      },
    });
    const panel = await screen.findByRole('region', { name: 'Screens found on your network' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    await settle();
    const toast = toastTexts().find((s) => s.includes("Couldn't add the screen"));
    expect(toast).toContain("This board can't keep its settings");
    expect(within(panel).queryByLabelText('The code on the screen')).toBeNull();
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
    // It shows the alert sign (as the hub's screens do unless switched off), and can leave it off.
    const sign = within(dialog).getByRole('checkbox', { name: /Alert sign/ }) as HTMLInputElement;
    expect(sign.checked).toBe(true);
    fireEvent.click(sign);
    // The preview is the picture as it will be, at the screen's size.
    await waitFor(() => expect(view.calls('GET /api/pills/*/image.jpg').length).toBeGreaterThan(0), { timeout: 3000 });
    expect(Object.fromEntries(view.calls('GET /api/pills/*/image.jpg').at(-1)!.query)).toMatchObject({
      w: '240',
      h: '240',
      theme: 'light',
    });
    expect(view.calls('GET /api/pills/*/image.jpg').at(-1)!.query.get('alerts')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(view.calls('PATCH /api/screens/*')[0]!.body).toMatchObject({
      pillId: pill.id,
      interval: 300,
      look: { show: ['gravity', 'temperature'], theme: 'light', alerts: false },
    });
    expect(toastTexts()).toContain('Kitchen saved');
  });

  it('sets up a board plugged into the hub over USB, then checks its panel', async () => {
    const usb: UsbStatus = {
      canSetUp: true,
      reason: null,
      esptool: '5.6.0',
      ports: [
        { path: 'COM7', name: 'USB-SERIAL CH340 (COM7)', vid: '1a86', pid: '7523', likely: true },
        { path: 'COM1', name: 'Communications Port (COM1)', vid: null, pid: null, likely: false },
      ],
    };
    const usbProgress = (over: Partial<ScreenSetupProgress> = {}) =>
      progress({ via: 'usb', hotspot: 'COM7', step: 'identify', steps: [{ step: 'identify', at: Date.now() }], ...over });
    const board = makeScreen({ id: '20500d33960c', name: 'Bar', model: 'esp32-2432s028', panel: 0 });
    const view = await renderWithHub(<ScreensPage />, {
      routes: {
        ...BASE,
        'GET /api/screens/wifi': WIFI,
        'POST /api/screens/wifi/scan': NETS,
        'GET /api/screens/usb': usb,
        'POST /api/screens/usb/setup': () => usbProgress(),
        'PATCH /api/screens/*': (req: FakeRequest) => ({ ...board, ...(req.body as object) }),
        'POST /api/screens/*/test-pattern': { ok: true },
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });
    // A board is plugged in, so that's what's being added: no Wi-Fi scan.
    const usbTab = await within(dialog).findByRole('button', { name: 'Plugged into the hub (USB)' });
    await waitFor(() => expect(usbTab.getAttribute('aria-pressed')).toBe('true'));
    expect(within(dialog).getByText(/ESP32-2432S028/)).toBeTruthy();
    const row = within(dialog).getByText('USB-SERIAL CH340 (COM7)').closest('li')!;
    expect(row.className).toContain('likely');
    expect(within(dialog).getByText('1 other port')).toBeTruthy();
    expect(view.calls('POST /api/screens/wifi/scan')).toHaveLength(0);
    fireEvent.click(within(row).getByRole('button', { name: 'Set up' }));
    // The networks around, for the board's Wi-Fi.
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Neighbours' })).toBeTruthy());
    expect(view.calls('POST /api/screens/wifi/scan')).toHaveLength(1);
    expect((within(dialog).getByRole('combobox', { name: 'Board' }) as HTMLSelectElement).value).toBe('esp32-2432s028');
    expect(within(dialog).queryByText(/off your network for a minute or two/)).toBeNull();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Bar' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set it up' }));
    await settle();
    expect(view.calls('POST /api/screens/usb/setup')[0]!.body).toMatchObject({
      port: 'COM7',
      model: 'esp32-2432s028',
      ssid: 'Brewery',
      password: '',
      name: 'Bar',
    });

    // Its own steps, and how far the install has got.
    await view.push({
      type: 'screen-setup',
      setup: usbProgress({ step: 'install', percent: 42, steps: SCREEN_USB_STEPS.slice(0, 2).map((s) => ({ step: s, at: 1 })) }),
    });
    expect(screen.getByText('USB: COM7', { exact: false })).toBeTruthy();
    expect(step('Installing RaptHooker firmware').textContent).toContain('42%');
    expect(screen.queryByText("Joining the screen's Wi-Fi")).toBeNull();

    await view.push({ type: 'screen', screen: board });
    await view.push({
      type: 'screen-setup',
      setup: usbProgress({ state: 'done', step: 'done', screenId: board.id, steps: SCREEN_USB_STEPS.map((s) => ({ step: s, at: 1 })) }),
    });
    expect(screen.getByRole('heading', { name: 'Bar is set up' })).toBeTruthy();
    expect(screen.getByText('Does the screen look right?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Swap red and blue' }));
    await settle();
    expect(view.calls('PATCH /api/screens/*')[0]!.body).toEqual({ panel: 4 });
    expect(view.calls('POST /api/screens/*/test-pattern')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Swap red and blue' }).getAttribute('aria-pressed')).toBe('true');
  });

  it("says why the hub can't set boards up over USB", async () => {
    await renderWithHub(<ScreensPage />, {
      routes: {
        ...BASE,
        'GET /api/screens/wifi': WIFI,
        'POST /api/screens/wifi/scan': NETS,
        'GET /api/screens/usb': { canSetUp: false, reason: 'no-esptool', esptool: null, ports: [] },
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });
    // Nothing plugged in: Wi-Fi screens first.
    await within(dialog).findByText('Smart weather clock');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Plugged into the hub (USB)' }));
    expect(within(dialog).getByText(/needs esptool/)).toBeTruthy();
    expect(within(dialog).getByText(/No boards plugged in/)).toBeTruthy();
  });

  it('sets boards that are already screens apart, and opens on Wi-Fi when no new board is plugged in', async () => {
    const known = makeScreen({ id: '20500d33960c', name: 'Bar', model: 'esp32-2432s028', panel: 0 });
    const board = { id: known.id, model: known.model, firmware: '1.1.1', name: 'Bar', hub: 'hub-1', claimed: true };
    await renderWithHub(<ScreensPage />, {
      screens: [known],
      routes: {
        ...BASE,
        'GET /api/screens/wifi': WIFI,
        'POST /api/screens/wifi/scan': NETS,
        'GET /api/screens/usb': {
          canSetUp: true,
          reason: null,
          esptool: '5.6.0',
          ports: [{ path: '/dev/ttyUSB0', name: 'QinHeng USB Serial', vid: '1a86', pid: '7523', likely: true, board }],
        },
      },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a screen' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a screen' });
    await within(dialog).findByText('Smart weather clock');
    expect(within(dialog).getByRole('button', { name: 'Wi-Fi screen' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Plugged into the hub (USB)' }));
    expect(within(dialog).getByText(/Every board plugged in is one of your screens already/)).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Already set up' })).toBeTruthy();
    const row = within(dialog).getByText('Bar').closest('li')!;
    expect(within(row).getByText(/firmware 1\.1\.1/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Set up again' }));
    expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Bar');
    expect(within(dialog).getByText(/This board is Bar/)).toBeTruthy();
  });

  it('offers no original firmware for a USB board, and a panel check instead', async () => {
    await renderWithHub(<ScreensPage />, {
      screens: [makeScreen({ model: 'esp32-2432s028', panel: 0 })],
      routes: BASE,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Kitchen' });
    expect(within(dialog).getByText('Does the screen look right?')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Put the original firmware back' })).toBeNull();
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

  it('says screens are experimental, and which screens work, with where working ones were bought', async () => {
    await renderWithHub(<ScreensPage />, { session: { role: 'viewer' }, routes: BASE });
    const note = screen.getByRole('note');
    expect(within(note).getByText('Screens are experimental.')).toBeTruthy();

    const panel = screen.getByRole('region', { name: /Supported screens/ });
    const scrolled: Element[] = [];
    panel.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    fireEvent.click(within(note).getByRole('button', { name: 'Which screens work' }));
    expect(scrolled).toEqual([panel]);

    expect(within(panel).getByText('Experimental')).toBeTruthy();
    // The unbranded Smart weather clock and the genuine GeekMagic Ultra it copies are listed apart.
    expect(within(panel).getByText('Smart weather clock')).toBeTruthy();
    expect(within(panel).getByText('GeekMagic Ultra')).toBeTruthy();
    expect(within(panel).queryByText(/Geekmagic Ultra\/Smart weather clock/)).toBeNull();
    expect(within(panel).getByText('ESP32-2432S028 2.8" (Cheap Yellow Display)')).toBeTruthy();
    const links = within(panel).getAllByRole('link', { name: 'Where a working one was bought (AliExpress)' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.aliexpress.com/item/1005011924447121.html',
      'https://www.aliexpress.com/item/1005007542991850.html',
      'https://www.aliexpress.com/item/1005010399042230.html',
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
    expect(within(panel).getByText(/They aren't endorsements/)).toBeTruthy();
    expect(within(panel).getAllByText('Might work')).toHaveLength(1);
    expect(within(panel).queryByText(/GeekMagic Ultra.*untested/i)).toBeNull();
    expect(within(panel).getAllByText("Won't work")).toHaveLength(2);
    // The one-line list it replaces is gone.
    expect(screen.queryByText(/Supported Screens:/)).toBeNull();
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

describe("a GeekMagic's own firmware, seen from the browser", () => {
  const stub = (answer: (init?: RequestInit) => Promise<Response>) => {
    const real = globalThis.fetch;
    globalThis.fetch = ((_url: string, init?: RequestInit) => answer(init)) as typeof fetch;
    return () => (globalThis.fetch = real);
  };

  it('reads what model it is, when it lets the page', async () => {
    const restore = stub(
      async () => new Response('{"m": "SmallTV-Ultra","v":"Ultra-V9.0.50"}', { headers: { 'Content-Type': 'text/json' } }),
    );
    try {
      expect(await geekmagicScreen()).toEqual({ model: 'SmallTV-Ultra' });
    } finally {
      restore();
    }
  });

  it("says when something answers but won't say what (no CORS), and when nothing does", async () => {
    // A cross-origin answer without CORS headers fails a normal fetch; one that doesn't read it ('no-cors') gets through.
    let restore = stub(async (init) => {
      if (init?.mode === 'no-cors') return new Response(null);
      throw new TypeError('Failed to fetch');
    });
    try {
      expect(await geekmagicScreen()).toBe('unreadable');
    } finally {
      restore();
    }
    restore = stub(async () => {
      throw new TypeError('Failed to fetch');
    });
    try {
      expect(await geekmagicScreen()).toBeNull();
    } finally {
      restore();
    }
    restore = stub(async () => new Response('<html>Smart Weather Clock</html>', { headers: { 'Content-Type': 'text/html' } }));
    try {
      expect(await geekmagicScreen()).toBeNull();
    } finally {
      restore();
    }
  });
});
