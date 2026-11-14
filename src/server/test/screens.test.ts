import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCREEN_ITEMS, hotspotKind, screenAddress, screenSetupSchema, type ScreenSetupProgress } from '@rapthooker/shared';
import { Settings } from '../settings.js';
import { parseConfig } from '../config.js';
import {
  compareVersions,
  crc8266,
  imageMarker,
  imageProblems,
  loadFirmware,
  md5,
  stockProblems,
  STOCK_SAFE_SIZE,
} from '../screens/firmware.js';
import { ScreenClient } from '../screens/client.js';
import { flashGeekmagic, flashStock, identifyGeekmagic, identifyStock } from '../screens/stock.js';
import { ScreenManager, upgradeScreen } from '../screens/manager.js';
import { FakeScreen, MockWifi, type FakeScreenOptions } from '../screens/simulator.js';
import { NoUsb } from '../screens/usb/types.js';
import { NoWifi } from '../screens/wifi/types.js';
import { parseNetworks } from '../screens/wifi/netsh.js';
import { silent, tempStore } from './helpers.js';

const firmware = loadFirmware();
const fw = firmware.get('sdpro-240')!;

/** The image with the length and CRC words worked out again after a change, as elf2bin would have. */
function withCrc(data: Buffer): Buffer {
  const d = Buffer.from(data);
  d.fill(0, 0x1010, 0x1018);
  d.writeUInt32LE(d.length, 0x1010);
  const zeroed = Buffer.from(d);
  zeroed.fill(0, 0x1010, 0x1018);
  d.writeUInt32LE(crc8266(zeroed), 0x1014);
  return d;
}

describe('screen firmware', () => {
  it('ships an image for the Smart Weather Clock that passes every check', () => {
    expect(fw).toBeDefined();
    expect(imageMarker(fw.data)).toEqual({ model: 'sdpro-240', version: fw.version });
    expect(imageProblems(fw.data)).toEqual([]);
    expect(stockProblems(fw.data, 'sdpro-240')).toEqual([]);
    expect(fw.size).toBeLessThanOrEqual(STOCK_SAFE_SIZE);
    expect(fw.md5).toBe(md5(fw.data));
  });

  it('turns down damaged images', () => {
    const cut = fw.data.subarray(0, fw.data.length - 100);
    expect(imageProblems(cut)).not.toEqual([]);
    const flipped = Buffer.from(fw.data);
    flipped[200_000]! ^= 1;
    expect(imageProblems(flipped)).toContain('bad checksum');
    const swapped = Buffer.from(fw.data);
    [swapped[150_000], swapped[150_010]] = [swapped[150_010]!, swapped[150_000]!];
    if (swapped[150_000] !== swapped[150_010]) expect(imageProblems(swapped)).toContain("CRC doesn't match");
    const boot = withCrc(Buffer.from(fw.data));
    boot[0x100]! ^= 4;
    expect(imageProblems(withCrc(boot))).toContain('bad boot loader checksum');
    const away = Buffer.from(fw.data);
    away.writeUInt32LE(0x50000000, 0x1008);
    expect(imageProblems(withCrc(away))).toContain('segment out of range');
    expect(imageProblems(Buffer.alloc(300_000, 0xe9))).not.toEqual([]);
    expect(imageProblems(Buffer.concat([fw.data, Buffer.from([0])]))).not.toEqual([]);
  });

  it('only lets an image that fits go to a stock screen', () => {
    const big = Buffer.concat([fw.data, Buffer.alloc(STOCK_SAFE_SIZE)]);
    expect(stockProblems(big, 'sdpro-240').length).toBeGreaterThan(0);
    expect(stockProblems(fw.data, 'other-model')).toContain('not RaptHooker firmware for other-model');
  });

  it('compares versions', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
  });
});

describe('netsh', () => {
  it("reads Windows' network list", () => {
    const text = [
      'SSID 1 : Smart weather clock',
      '    Network type            : Infrastructure',
      '    Authentication          : Open',
      '    BSSID 1                 : f2:08:d1:1c:17:58',
      '         Signal             : 66%',
      '         Band               : 2.4 GHz',
      '         Channel            : 1',
      'SSID 2 : rc',
      '    Authentication          : WPA2-Personal',
      '    BSSID 1                 : 3c:7c:3f:65:59:b4',
      '         Signal             : 84%',
      '         Band               : 5 GHz',
      '         Channel            : 52',
    ].join('\r\n');
    expect(parseNetworks(text, 'rc')).toEqual([
      {
        ssid: 'Smart weather clock',
        bssid: 'f2:08:d1:1c:17:58',
        signal: 66,
        channel: 1,
        band: 2.4,
        secure: false,
        kind: 'sdpro',
        current: false,
      },
      { ssid: 'rc', bssid: '3c:7c:3f:65:59:b4', signal: 84, channel: 52, band: 5, secure: true, kind: null, current: true },
    ]);
  });
});

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function world(
  opts: {
    stock?: boolean;
    firmware?: string;
    knowsPassword?: boolean;
    stockOta?: FakeScreenOptions['stockOta'];
    legacy?: boolean;
    on5GHz?: number;
    stockKind?: FakeScreenOptions['stockKind'];
    geekmagicModel?: string;
    stockOnNetwork?: boolean;
    noStore?: boolean;
  } = {},
) {
  const t = tempStore();
  const fake = new FakeScreen({
    stock: opts.stock ?? true,
    firmware: opts.firmware,
    networks: { Brewery: 'hops-and-barley' },
    fetchPictures: false,
    stockOta: opts.stockOta,
    legacy: opts.legacy,
    stockKind: opts.stockKind,
    geekmagicModel: opts.geekmagicModel,
    stockOnNetwork: opts.stockOnNetwork,
    noStore: opts.noStore,
  });
  await fake.start();
  const fakes = [fake];
  const wifi = new MockWifi(() => fakes, undefined, { knowsPassword: opts.knowsPassword, on5GHz: opts.on5GHz });
  const settings = new Settings(t.store);
  const screens = new ScreenManager({
    store: t.store,
    settings,
    log: silent,
    wifi,
    usb: new NoUsb('off'),
    firmware,
    addresses: async () => [{ kind: 'lan', url: 'http://192.168.50.104:8080' }],
    lookup: async (hostname) => (fake.online && hostname === `rh-screen-${fake.id.slice(-6)}` ? fake.address : null),
    browse: async () =>
      fake.online
        ? [
            {
              id: fake.id,
              model: 'sdpro-240',
              firmware: fake.firmware,
              api: 1,
              ip: fake.address,
              hostname: `rh-screen-${fake.id.slice(-6)}`,
              claimed: !!fake.settings.token,
            },
          ]
        : [],
    fast: true,
  });
  screens.load();
  cleanups.push(async () => {
    screens.stop();
    await fake.stop();
    t.cleanup();
  });
  return { t, fake, wifi, screens, settings };
}

function finished(screens: ScreenManager): Promise<ScreenSetupProgress> {
  return new Promise((resolve) => {
    screens.on('setup', (p: ScreenSetupProgress) => {
      if (p.state !== 'running') resolve(p);
    });
  });
}

const input = {
  hotspot: 'Smart weather clock',
  ssid: 'Brewery',
  password: '',
  name: 'Kitchen',
  pillId: null,
  look: { palette: 'hops' as const },
};

describe('setting a screen up', () => {
  it('puts RaptHooker on a stock screen, has it join the network and saves it', async () => {
    const { fake, wifi, screens } = await world();
    expect((await identifyStock(fake.address))?.mac).toBe('02:52:48:00:00:01');
    const done = finished(screens);
    expect(screens.startSetup(input).state).toBe('running');
    const p = await done;
    expect(p).toMatchObject({ state: 'done', error: null, screenId: fake.id, hubBack: true });
    expect(p.steps.map((s) => s.step)).toEqual(['hotspot', 'identify', 'install', 'restart', 'screen', 'wifi', 'back', 'find', 'done']);
    expect(fake.events).toContain(`stock ota ${fw.version}`);
    expect(fake.events).toContain('setup Brewery on channel 6');
    expect(fake.settings).toMatchObject({ ssid: 'Brewery', pass: 'hops-and-barley', hub: screens.hubId(), name: 'Kitchen' });
    expect(fake.settings.imageUrl).toBe(`http://192.168.50.104:8080/api/screens/${fake.id}/image.jpg`);
    expect(wifi.joins).toEqual(['Smart weather clock', 'RaptHooker-Screen-000001']);
    expect(wifi.current).toBe('Brewery');
    const screen = screens.get(fake.id)!;
    expect(screen).toMatchObject({
      name: 'Kitchen',
      model: 'sdpro-240',
      mac: '02:52:48:00:00:01',
      hostname: 'rh-screen-000001',
      ip: fake.address,
      firmware: fw.version,
    });
    expect(screen.look).toMatchObject({ palette: 'hops', theme: 'dark', show: [...DEFAULT_SCREEN_ITEMS] });
    // Saved, with the key the screen was given.
    const row = JSON.parse(
      (screens as unknown as { deps: { store: { db: { prepare(s: string): { get(): { json: string } } } } } }).deps.store.db
        .prepare('SELECT json FROM screens')
        .get().json,
    ) as { token: string };
    expect(row.token).toBe(fake.settings.token);
    expect(row.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('carries on when the stock firmware restarts without saying OK', async () => {
    const { fake, screens } = await world({ stockOta: 'no-reply' });
    const done = finished(screens);
    screens.startSetup(input);
    expect(await done).toMatchObject({ state: 'done', screenId: fake.id });
    expect(fake.firmware).toBe(fw.version);
  });

  it("says when the firmware didn't take, going by the stock hotspot coming back", async () => {
    const { fake, wifi, screens } = await world({ stockOta: 'refuse-quietly' });
    const done = finished(screens);
    screens.startSetup(input);
    expect(await done).toMatchObject({
      state: 'failed',
      error: 'install-failed',
      detail: 'The screen is still on its own firmware',
      hubBack: true,
    });
    expect(fake.stock).toBe(true);
    expect(wifi.current).toBe('Brewery');
  });

  it('sends a screen that joined the network by itself to Found on your network', async () => {
    const { fake, screens } = await world();
    // RaptHooker was on it before, and its settings outlasted the stock firmware going back on.
    fake.settings = { ...fake.settings, ssid: 'Brewery', pass: 'hops-and-barley', token: 'a-key-no-hub-has-now', hub: 'old' };
    const done = finished(screens);
    screens.startSetup(input);
    expect(await done).toMatchObject({ state: 'failed', error: 'on-network', detail: `rh-screen-${fake.id.slice(-6)}`, hubBack: true });
    expect(screens.list()).toEqual([]);
  });

  it("gives the screen the network's 2.4 GHz channel when the hub is on its 5 GHz band", async () => {
    // A router with the same name on both bands, and the hub on 5 GHz: the screen can only use 2.4 GHz.
    const { fake, screens } = await world({ stock: false, on5GHz: 116 });
    const done = finished(screens);
    screens.startSetup({ ...input, hotspot: 'RaptHooker-Screen-000001' });
    expect(await done).toMatchObject({ state: 'done', screenId: fake.id });
    expect(fake.events).toContain('setup Brewery on channel 6');
  });

  it("gets back on its network when it couldn't join the screen's", async () => {
    const { wifi, screens } = await world();
    const done = finished(screens);
    screens.startSetup({ ...input, hotspot: 'Smart weather clock Pro' });
    expect(await done).toMatchObject({ state: 'failed', error: 'hotspot-failed', hubBack: true });
    expect(wifi.current).toBe('Brewery');
  });

  it('says the password is wrong, and the hub is back on its network', async () => {
    const { fake, wifi, screens } = await world({ stock: false });
    const done = finished(screens);
    screens.startSetup({ ...input, hotspot: 'RaptHooker-Screen-000001', password: 'nope' });
    const p = await done;
    expect(p).toMatchObject({ state: 'failed', error: 'wrong-password', step: 'wifi', hubBack: true });
    expect(wifi.current).toBe('Brewery');
    expect(fake.settings.token).toBe('');
    expect(screens.list()).toEqual([]);
  });

  it("won't guess a password it hasn't got", async () => {
    const { screens } = await world({ stock: false, knowsPassword: false });
    const done = finished(screens);
    screens.startSetup({ ...input, hotspot: 'RaptHooker-Screen-000001' });
    expect(await done).toMatchObject({ state: 'failed', error: 'no-password' });
  });

  it("leaves alone anything that isn't a screen it knows", async () => {
    const { fake, wifi, screens } = await world();
    fake.stock = false;
    (fake as unknown as { handle: unknown }).handle = async (_req: unknown, res: { writeHead(n: number): void; end(s: string): void }) => {
      res.writeHead(200);
      res.end('<html><title>Router</title></html>');
    };
    const done = finished(screens);
    screens.startSetup({ ...input, hotspot: 'RaptHooker-Screen-000001' });
    expect(await done).toMatchObject({ state: 'failed', error: 'not-supported', hubBack: true });
    expect(wifi.current).toBe('Brewery');
  });

  it("says a board can't keep its settings before giving it any, even one a set-up it couldn't save left claimed", async () => {
    // RaptHooker put on an ESP32 board as an update over ESPHome: no flash layout of its own.
    const { fake, wifi, screens } = await world({ stock: false, noStore: true });
    const hotspot = { ...input, hotspot: 'RaptHooker-Screen-000001', password: 'hops-and-barley' };
    let done = finished(screens);
    screens.startSetup(hotspot);
    expect(await done).toMatchObject({ state: 'failed', error: 'no-store', step: 'screen', hubBack: true });
    expect(fake.events.filter((e) => e.startsWith('setup'))).toEqual([]);
    expect(fake.settings.token).toBe('');
    expect(wifi.current).toBe('Brewery');
    expect(screens.list()).toEqual([]);

    // A set-up from a browser joined it to the network, but couldn't save: it holds the key until it restarts.
    fake.settings = { ...fake.settings, token: 'a-key-it-could-not-keep', hub: screens.hubId() };
    done = finished(screens);
    screens.startSetup(hotspot);
    expect(await done).toMatchObject({ state: 'failed', error: 'no-store', step: 'screen' });
  });

  it('brings a screen on older firmware up to date first', async () => {
    const { fake, screens } = await world({ stock: false, firmware: '0.9.0' });
    const done = finished(screens);
    screens.startSetup({ ...input, hotspot: 'RaptHooker-Screen-000001', password: 'hops-and-barley' });
    expect(await done).toMatchObject({ state: 'done' });
    expect(fake.events).toContain(`ota ${fw.version}`);
    expect(screens.get(fake.id)?.firmware).toBe(fw.version);
  });

  it('sets up one screen at a time', async () => {
    const { screens } = await world();
    const done = finished(screens);
    screens.startSetup(input);
    expect(() => screens.startSetup(input)).toThrow('already');
    await done;
  });

  it("tells a hub that can't switch networks", async () => {
    const t = tempStore();
    cleanups.push(() => t.cleanup());
    const screens = new ScreenManager({
      store: t.store,
      settings: new Settings(t.store),
      log: silent,
      wifi: new NoWifi('no-networkmanager'),
      usb: new NoUsb('off'),
      firmware,
      addresses: async () => [],
      lookup: async () => null,
      browse: async () => [],
      fast: true,
    });
    expect((await screens.wifiStatus()).canSetUp).toBe(false);
    const done = finished(screens);
    screens.startSetup({ ...input, password: 'x' });
    expect(await done).toMatchObject({ state: 'failed', error: 'no-wifi-control', detail: 'no-networkmanager' });
  });
});

describe('setting up a GeekMagic Ultra', () => {
  const giftv = { ...input, hotspot: 'GIFTV' };

  it('knows its hotspot, and addresses as people type them', () => {
    expect(hotspotKind('GIFTV')).toBe('geekmagic');
    expect(hotspotKind('Smart weather clock')).toBe('sdpro');
    expect(hotspotKind('RaptHooker-Screen-1C1802')).toBe('rapthooker');
    expect(hotspotKind('Brewery')).toBeNull();
    expect(screenAddress(' http://192.168.1.50/ ')).toBe('192.168.1.50');
    expect(screenAddress('geekmagic.local:8080')).toBe('geekmagic.local:8080');
    expect(screenAddress('192.168.1.50/update')).toBeNull();
    expect(screenAddress('')).toBeNull();
    expect(screenSetupSchema.parse({ ...input, hotspot: '', address: 'http://192.168.1.50' })).toMatchObject({ address: '192.168.1.50' });
    expect(() => screenSetupSchema.parse({ ...input, hotspot: '' })).toThrow();
    expect(() => screenSetupSchema.parse({ ...input, address: 'not an address' })).toThrow();
  });

  it('puts RaptHooker on one from its hotspot, through its own update page, and saves it', async () => {
    const { fake, wifi, screens } = await world({ stockKind: 'geekmagic' });
    expect(await identifyGeekmagic(fake.address)).toEqual({ model: 'SmallTV-Ultra', version: 'Ultra-V9.0.50' });
    const done = finished(screens);
    screens.startSetup(giftv);
    const p = await done;
    expect(p).toMatchObject({ state: 'done', error: null, screenId: fake.id, hubBack: true });
    expect(p.steps.map((s) => s.step)).toEqual(['hotspot', 'identify', 'install', 'restart', 'screen', 'wifi', 'back', 'find', 'done']);
    expect(fake.events).toContain(`geekmagic ota ${fw.version}`);
    expect(fake.settings).toMatchObject({ ssid: 'Brewery', pass: 'hops-and-barley', hub: screens.hubId(), name: 'Kitchen' });
    // RaptHooker's hotspot went by the GeekMagic's: the same last three bytes.
    expect(wifi.joins).toEqual(['GIFTV', 'RaptHooker-Screen-000001']);
    expect(wifi.current).toBe('Brewery');
    // The same hardware, and the same firmware, as a Smart weather clock.
    expect(screens.get(fake.id)).toMatchObject({ model: 'sdpro-240', mac: '02:52:48:00:00:01', firmware: fw.version });
  });

  it("finds RaptHooker's hotspot when it isn't named as expected", async () => {
    const { fake, wifi, screens } = await world({ stockKind: 'geekmagic' });
    Object.defineProperty(fake, 'bssid', { get: () => '0a:00:00:aa:bb:cc' });
    const done = finished(screens);
    screens.startSetup(giftv);
    expect(await done).toMatchObject({ state: 'done', screenId: fake.id });
    expect(wifi.joins).toContain('RaptHooker-Screen-AABBCC');
    expect(wifi.joins.at(-1)).toBe('RaptHooker-Screen-000001');
  });

  it("sets one up that's on the network already, from its address", async () => {
    const { fake, wifi, screens } = await world({ stockKind: 'geekmagic', stockOnNetwork: true });
    const done = finished(screens);
    const started = screens.startSetup(screenSetupSchema.parse({ ...input, hotspot: '', address: `http://${fake.address}/` }));
    expect(started).toMatchObject({ step: 'identify', hotspot: fake.address });
    const p = await done;
    expect(p).toMatchObject({ state: 'done', screenId: fake.id, hubBack: true });
    expect(p.steps.map((s) => s.step)).toEqual(['identify', 'install', 'restart', 'screen', 'wifi', 'back', 'find', 'done']);
    expect(fake.events).toContain(`geekmagic ota ${fw.version}`);
    expect(wifi.joins).toEqual(['RaptHooker-Screen-000001']);
    expect(wifi.current).toBe('Brewery');
  });

  it('leaves other GeekMagic models alone', async () => {
    const { fake, wifi, screens } = await world({ stockKind: 'geekmagic', geekmagicModel: 'SmallTV-Pro' });
    const done = finished(screens);
    screens.startSetup(giftv);
    expect(await done).toMatchObject({
      state: 'failed',
      error: 'not-supported',
      detail: expect.stringContaining('SmallTV-Pro'),
      hubBack: true,
    });
    expect(fake.events).toEqual([]);
    expect(fake.stock).toBe(true);
    expect(wifi.current).toBe('Brewery');
  });

  it("won't install anything at an address that isn't a GeekMagic Ultra", async () => {
    const { fake, screens } = await world({ stock: true });
    const done = finished(screens);
    screens.startSetup({ ...input, hotspot: '', address: fake.address });
    expect(await done).toMatchObject({ state: 'failed', error: 'not-supported', hubBack: true });
    expect(fake.events).toEqual([]);
  });

  it('says what its update page said when it refuses the firmware', async () => {
    const { fake, screens } = await world({ stockKind: 'geekmagic', stockOta: 'refuse' });
    const done = finished(screens);
    screens.startSetup(giftv);
    expect(await done).toMatchObject({
      state: 'failed',
      error: 'install-failed',
      detail: 'the screen said ERROR[2]: Flash Write Failed',
      hubBack: true,
    });
    expect(fake.stock).toBe(true);
  });

  it('carries on when it restarts without answering', async () => {
    const { fake, screens } = await world({ stockKind: 'geekmagic', stockOta: 'no-reply' });
    const done = finished(screens);
    screens.startSetup(giftv);
    expect(await done).toMatchObject({ state: 'done', screenId: fake.id });
  });

  it("says when the firmware didn't take, going by the GeekMagic coming back", { timeout: 10_000 }, async () => {
    const { fake, wifi, screens } = await world({ stockKind: 'geekmagic', stockOta: 'refuse-quietly' });
    const done = finished(screens);
    screens.startSetup(giftv);
    expect(await done).toMatchObject({ state: 'failed', error: 'install-failed', detail: 'The screen is still on its own firmware' });
    expect(fake.stock).toBe(true);
    expect(wifi.current).toBe('Brewery');
  });

  it("doesn't touch the hub's Wi-Fi from an address when RaptHooker's hotspot never comes", { timeout: 10_000 }, async () => {
    const { fake, wifi, screens } = await world({ stockKind: 'geekmagic', stockOnNetwork: true, stockOta: 'refuse-quietly' });
    // On Windows, restoring with nothing to go back to disconnects the hub: it mustn't be asked to when it never left.
    let restores = 0;
    const restore = wifi.restore.bind(wifi);
    wifi.restore = async () => {
      restores++;
      return restore();
    };
    const done = finished(screens);
    screens.startSetup({ ...input, hotspot: '', address: fake.address });
    expect(await done).toMatchObject({ state: 'failed', error: 'install-failed', hubBack: true });
    expect(wifi.joins).toEqual([]);
    expect(restores).toBe(0);
    expect(wifi.current).toBe('Brewery');
  });

  it('is sent only an image that passes, and told apart from other firmware', async () => {
    const fake = new FakeScreen({ stockKind: 'geekmagic', fetchPictures: false });
    await fake.start();
    cleanups.push(() => fake.stop());
    await expect(flashGeekmagic(fake.address, { ...fw, data: fw.data.subarray(0, 1000) })).rejects.toThrow("can't go to this screen");
    expect(fake.events).toEqual([]);
    expect(await identifyStock(fake.address)).toBeNull();
    const sdpro = new FakeScreen({ fetchPictures: false });
    await sdpro.start();
    cleanups.push(() => sdpro.stop());
    expect(await identifyGeekmagic(sdpro.address)).toBeNull();
    expect(await flashGeekmagic(fake.address, fw)).toBe(true);
    expect(fake.events).toEqual([`geekmagic ota ${fw.version}`]);
  });

  it('has RaptHooker put on one on the network for a browser to finish', async () => {
    const { fake, screens } = await world({ stockKind: 'geekmagic', stockOnNetwork: true });
    expect(await screens.install(fake.address)).toMatchObject({
      found: { model: 'SmallTV-Ultra', version: 'Ultra-V9.0.50' },
      firmware: { model: 'sdpro-240', version: fw.version, md5: fw.md5 },
      confirmed: true,
    });
    expect(fake.events).toContain(`geekmagic ota ${fw.version}`);
    // Restarted with RaptHooker, waiting on its hotspot to be set up.
    await new Promise((r) => setTimeout(r, fake.restartMs + 50));
    expect(fake.hotspot).toBe('RaptHooker-Screen-000001');
  });

  it("won't put RaptHooker on anything else from the network", async () => {
    const pro = await world({ stockKind: 'geekmagic', geekmagicModel: 'SmallTV-Pro', stockOnNetwork: true });
    await expect(pro.screens.install(pro.fake.address)).rejects.toThrow('SmallTV-Pro');
    expect(pro.fake.events).toEqual([]);
    const sdpro = await world();
    await expect(sdpro.screens.install(sdpro.fake.address)).rejects.toThrow('No GeekMagic Ultra');
    expect(sdpro.fake.events).toEqual([]);
  });
});

describe('looking after screens', () => {
  async function setUp() {
    const w = await world();
    const done = finished(w.screens);
    w.screens.startSetup(input);
    await done;
    return w;
  }

  it('works out how a screen is doing from its picture requests', async () => {
    const { fake, screens } = await setUp();
    expect(screens.get(fake.id)!.status.state).toBe('unknown');
    screens.seen(
      fake.id,
      { 'x-screen-id': fake.id, 'x-screen-status': 'rssi=-61;up=120;heap=35000;fail=2', 'x-screen-firmware': 'sdpro-240/1.0.0' },
      '::ffff:192.168.50.9',
    );
    expect(screens.get(fake.id)!.status).toMatchObject({ state: 'online', rssi: -61, uptime: 120, failures: 2 });
    // Someone else asking for the picture (the app's preview) doesn't count.
    screens.seen(fake.id, {}, '192.168.50.20');
    expect(screens.pictureOf(fake.id)).toMatchObject({ pillId: null, interval: 60, options: { width: 240, height: 240, palette: 'hops' } });
    expect(screens.pictureOf('nope')).toBeNull();
  });

  it('sends a screen its new settings, and shows a new look straight away', async () => {
    const { fake, screens } = await setUp();
    fake.events.length = 0;
    const d = await screens.patch(fake.id, { name: 'Shed', brightness: 40, look: { theme: 'light' } });
    expect(d).toMatchObject({ name: 'Shed', brightness: 40, look: { theme: 'light', palette: 'hops' } });
    expect(fake.settings).toMatchObject({ name: 'Shed', brightness: 40 });
    expect(fake.events).toContain('refresh');
    fake.events.length = 0;
    await screens.patch(fake.id, { pillId: 'f00d5eed0003' });
    expect(fake.events).toEqual(['refresh']);
  });

  it('updates firmware and checks the screen came back with it', async () => {
    const { fake, screens } = await setUp();
    // As if the hub had been updated with newer firmware than the screen's.
    const older = '0.9.0';
    fake.firmware = older;
    screens.seen(fake.id, { 'x-screen-id': fake.id, 'x-screen-firmware': `sdpro-240/${older}` }, null);
    expect(screens.get(fake.id)!.status.update).toBe(fw.version);
    const d = await screens.updateFirmware(fake.id);
    expect(d.firmware).toBe(fw.version);
    expect(d.status).toMatchObject({ update: null, updating: false, error: null });
    expect(await screens.updateAll()).toEqual({ updated: [], failed: [] });
  });

  it('gives a screen the new picture address when the hub moves', async () => {
    const { fake, screens } = await setUp();
    (screens as unknown as { deps: { addresses: () => Promise<unknown> } }).deps.addresses = async () => [
      { kind: 'lan', url: 'http://192.168.50.77:8080' },
    ];
    await screens.check([fake.id]);
    expect(fake.settings.imageUrl).toBe(`http://192.168.50.77:8080/api/screens/${fake.id}/image.jpg`);
  });

  it('takes over a screen another hub has, with the code it shows', async () => {
    const { fake, screens } = await setUp();
    fake.settings.token = 'someone-elses-key-0123456789';
    await screens.remove(fake.id, false);
    await screens.discover();
    expect(screens.found()).toMatchObject([{ id: fake.id, claimed: true }]);
    expect(await screens.adopt(fake.id, undefined, undefined)).toEqual({ screen: null, needsCode: true });
    expect(fake.pairingCode).toMatch(/^\d{6}$/);
    await expect(screens.adopt(fake.id, '000000' === fake.pairingCode ? '111111' : '000000', undefined)).rejects.toThrow('wrong-code');
    const { screen } = await screens.adopt(fake.id, fake.pairingCode!, 'Garage');
    expect(screen).toMatchObject({ id: fake.id, name: 'Garage' });
    expect(fake.settings.token).not.toBe('someone-elses-key-0123456789');
    expect(screens.found()).toEqual([]);
  });

  it("won't add a board found on the network that can't keep its settings", async () => {
    const { fake, screens } = await setUp();
    await screens.remove(fake.id, false);
    fake.noStore = true;
    await screens.discover();
    await expect(screens.adopt(fake.id, undefined, undefined)).rejects.toMatchObject({ message: 'no-store', statusCode: 409 });
    expect(fake.pairingCode).toBeNull();
    expect(screens.list()).toEqual([]);
  });

  it('forgets a screen, resetting it if asked', async () => {
    const { fake, screens } = await setUp();
    await screens.remove(fake.id, true);
    expect(fake.events).toContain('reset');
    expect(screens.list()).toEqual([]);
    await expect(screens.remove(fake.id, false)).rejects.toThrow('Unknown screen');
  });

  it('puts the original firmware back only from a real firmware file', async () => {
    const { fake, screens } = await setUp();
    await expect(screens.restoreStock(fake.id, Buffer.from('hello'))).rejects.toThrow("isn't firmware");
    await expect(screens.restoreStock(fake.id, fw.data)).rejects.toThrow("RaptHooker's own");
  });

  it('keeps a browser set-up waiting until the browser says it worked', async () => {
    const { screens } = await world();
    const start = await screens.manualStart({ name: 'Bar', pillId: null, look: {} });
    expect(start).toMatchObject({ hub: screens.hubId(), imageBase: 'http://192.168.50.104:8080/api/screens/' });
    expect(start.token).toMatch(/^[0-9a-f]{32}$/);
    expect(start.firmware).toContainEqual({ model: 'sdpro-240', version: fw.version, size: fw.size, md5: fw.md5 });
    const d = screens.manualDone({ pending: start.pending, id: 'f008d11c1802', model: 'sdpro-240', ip: null });
    expect(d).toMatchObject({ id: 'f008d11c1802', name: 'Bar', mac: 'F0:08:D1:1C:18:02', hostname: 'rh-screen-1c1802' });
    expect(() => screens.manualDone({ pending: start.pending, id: 'f008d11c1802', model: 'sdpro-240', ip: null })).toThrow('expired');
  });

  it("keeps a screen's settings it doesn't know when it saves", () => {
    const saved = upgradeScreen({ name: 'Old', token: 'k', future: { x: 1 } }, { gravity: 'plato', temperature: 'F' });
    expect(saved).toMatchObject({
      name: 'Old',
      model: 'sdpro-240',
      interval: 60,
      brightness: 80,
      // Saved before decimals could be picked: the hub's. Before the alert sign: it shows.
      look: { gravity: 'plato', temperature: 'F', gravityDecimals: null, temperatureDecimals: null, alerts: true },
    });
    // One that was switched off stays off, and what a newer version keeps in the look stays too.
    const off = upgradeScreen({ name: 'Off', look: { alerts: false, future: 1 } }, { gravity: 'sg', temperature: 'C' });
    expect(off.look).toMatchObject({ alerts: false, future: 1 });
  });

  it("draws a screen's picture with or without the alert sign, as it's set", async () => {
    const { fake, screens } = await setUp();
    expect(screens.pictureOf(fake.id)!.options).toMatchObject({ alerts: true });
    await screens.patch(fake.id, { look: { alerts: false } });
    expect(screens.pictureOf(fake.id)!.options).toMatchObject({ alerts: false, palette: 'hops' });
  });

  it("draws a screen's picture with its own decimals, or the hub's", async () => {
    const { fake, screens } = await setUp();
    expect(screens.pictureOf(fake.id)!.options).toMatchObject({ gravityDecimals: null, temperatureDecimals: null });
    await screens.patch(fake.id, { look: { gravityDecimals: 3, temperatureDecimals: 2 } });
    expect(screens.pictureOf(fake.id)!.options).toMatchObject({ gravityDecimals: 3, temperatureDecimals: 2, palette: 'hops' });
    await screens.patch(fake.id, { look: { gravityDecimals: null } });
    expect(screens.pictureOf(fake.id)!.options).toMatchObject({ gravityDecimals: null, temperatureDecimals: 2 });
  });
});

describe('screens in the config', () => {
  it('takes the address screens fetch pictures from, for a hub that can see its own', () => {
    const at = (screens: unknown) => parseConfig({ screens }, '/tmp', '/tmp').screens;
    expect(at(undefined)).toEqual({ wifi: 'auto', hubUrl: '', usb: 'auto', python: '' });
    expect(at({ wifi: 'off', hubUrl: ' http://192.168.1.20:8080/ ' })).toMatchObject({ wifi: 'off', hubUrl: 'http://192.168.1.20:8080' });
    expect(at({ usb: 'off', python: ' /opt/py/bin/python3 ' })).toMatchObject({ usb: 'off', python: '/opt/py/bin/python3' });
    expect(() => at({ usb: 'serial' })).toThrow();
    expect(() => at({ hubUrl: '192.168.1.20' })).toThrow('screens.hubUrl');
    expect(() => at({ hubUrl: 'http://192.168.1.20:8080/api' })).toThrow('screens.hubUrl');
    // Screens can't fetch over https.
    expect(() => at({ hubUrl: 'https://hub.example.com' })).toThrow('screens.hubUrl');
  });
});

describe("a screen's key", () => {
  /** What saved screen says, changed behind the hub's back, then read again. */
  function movedTo(t: ReturnType<typeof tempStore>, screens: ScreenManager, id: string, ip: string) {
    const db = t.store.db;
    const row = db.prepare('SELECT json FROM screens WHERE id = ?').get(id) as { json: string };
    db.prepare('UPDATE screens SET json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.json), ip }), id);
    screens.load();
  }

  async function setUp(opts: { legacy?: boolean } = {}) {
    const w = await world(opts);
    const done = finished(w.screens);
    w.screens.startSetup(input);
    expect(await done).toMatchObject({ state: 'done' });
    // Something else on the network, answering as the screen but without its key.
    const impostor = new FakeScreen({ mac: w.fake.mac, stock: false, fetchPictures: false, legacy: opts.legacy });
    await impostor.start();
    cleanups.push(() => impostor.stop());
    return { ...w, impostor };
  }

  it('only goes to an address that proves it has it', async () => {
    const { t, fake, screens, impostor } = await setUp();
    // Picture requests and mDNS answers can be faked: say one has the hub think the screen moved to the impostor.
    movedTo(t, screens, fake.id, impostor.address);
    expect(screens.get(fake.id)!.ip).toBe(impostor.address);
    fake.keysSeen.length = 0;
    await screens.action(fake.id, 'identify');
    expect(impostor.keysSeen).toEqual([]);
    expect(fake.events).toContain('identify');
    expect(fake.keysSeen).toContain(`Bearer ${fake.settings.token}`);
    expect(new Set(fake.keysSeen)).toEqual(new Set([`Bearer ${fake.settings.token}`]));
    // Where it really is, again.
    expect(screens.get(fake.id)!.ip).toBe(fake.address);
  });

  it('has to be proved again by a screen that has proved it once', async () => {
    const { t, fake, screens, impostor } = await setUp();
    await screens.action(fake.id, 'identify');
    // An impostor that says it's on firmware too old to prove anything gets nothing either.
    impostor.legacy = true;
    movedTo(t, screens, fake.id, impostor.address);
    await fake.stop();
    await expect(screens.action(fake.id, 'identify')).rejects.toThrow();
    expect(impostor.keysSeen).toEqual([]);
  });

  it('is taken at its word from firmware too old to prove it', async () => {
    const { fake, screens } = await setUp({ legacy: true });
    await screens.action(fake.id, 'identify');
    expect(fake.events).toContain('identify');
  });
});

describe('the stock firmware', () => {
  it('is sent only an image that passes, and says OK', async () => {
    const fake = new FakeScreen({ fetchPictures: false });
    await fake.start();
    cleanups.push(() => fake.stop());
    expect(await flashStock(fake.address, fw)).toBe(true);
    expect(fake.events).toContain(`stock ota ${fw.version}`);
    await expect(flashStock(fake.address, { ...fw, data: fw.data.subarray(0, 1000) })).rejects.toThrow("can't go to this screen");
  });

  it("can't always say OK before it restarts", async () => {
    const quiet = new FakeScreen({ fetchPictures: false, stockOta: 'no-reply' });
    await quiet.start();
    cleanups.push(() => quiet.stop());
    // The whole image went: no answer is no answer either way.
    expect(await flashStock(quiet.address, fw)).toBe(false);
    const refusing = new FakeScreen({ fetchPictures: false, stockOta: 'refuse' });
    await refusing.start();
    cleanups.push(() => refusing.stop());
    await expect(flashStock(refusing.address, fw)).rejects.toThrow('500 FAIL');
  });

  it('is told apart from our firmware', async () => {
    const fake = new FakeScreen({ stock: false, fetchPictures: false });
    await fake.start();
    cleanups.push(() => fake.stop());
    expect(await identifyStock(fake.address)).toBeNull();
    expect((await new ScreenClient(fake.address).info()).firmware).toBe('rapthooker-screen');
  });
});
