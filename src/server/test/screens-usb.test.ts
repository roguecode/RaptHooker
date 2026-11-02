import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCREEN_PANEL, SCREEN_USB_STEPS, type ScreenSetupProgress, type ScreenUsbSetupInput } from '@rapthooker/shared';
import { Settings } from '../settings.js';
import {
  esp32BootProblems,
  esp32ImageProblems,
  ESP32_APP_AT,
  ESP32_APP_SIZE,
  ESP32_BOOT_AT,
  ESP32_SETTINGS_AT,
  imageMarker,
  loadFirmware,
  md5,
  partitionTable,
} from '../screens/firmware.js';
import { ScreenManager } from '../screens/manager.js';
import { type FakeScreen, MockUsb, MockWifi } from '../screens/simulator.js';
import { chipFamily, EsptoolFlasher, esptoolProblem, parseBoard, parseWhois, WriteProgress } from '../screens/usb/esptool.js';
import { linuxPorts, parseWindowsPorts } from '../screens/usb/ports.js';
import { crc32, readSettingsSector, SECTOR, settingsSector } from '../screens/usb/sector.js';
import { silent, tempStore } from './helpers.js';

const firmware = loadFirmware();
const fw = firmware.get('esp32-2432s028')!;

describe('ESP32 screen firmware', () => {
  it('ships an image and a boot blob for the ESP32-2432S028 that pass every check', () => {
    expect(fw).toMatchObject({ chip: 'esp32', size: fw.data.length, md5: md5(fw.data) });
    expect(imageMarker(fw.data)).toEqual({ model: 'esp32-2432s028', version: fw.version });
    expect(esp32ImageProblems(fw.data)).toEqual([]);
    expect(fw.size).toBeLessThanOrEqual(ESP32_APP_SIZE);
    expect(fw.boot).not.toBeNull();
    expect(esp32BootProblems(fw.boot!)).toEqual([]);
    const parts = partitionTable(fw.boot!.subarray(0x8000 - ESP32_BOOT_AT, 0x8000 - ESP32_BOOT_AT + 0xc00));
    expect(parts.map((p) => [p.label, p.offset])).toEqual([
      ['nvs', 0x9000],
      ['otadata', 0xe000],
      ['app0', ESP32_APP_AT],
      ['app1', ESP32_APP_AT + ESP32_APP_SIZE],
      ['rhscreen', ESP32_SETTINGS_AT],
      ['coredump', 0x3f0000],
    ]);
  });

  it('turns down damaged ESP32 images and boot blobs', () => {
    const flipped = Buffer.from(fw.data);
    flipped[300_000]! ^= 1;
    expect(esp32ImageProblems(flipped)).not.toEqual([]);
    expect(esp32ImageProblems(fw.data.subarray(0, fw.data.length - 1))).not.toEqual([]);
    const otherChip = Buffer.from(fw.data);
    otherChip[12] = 9;
    expect(esp32ImageProblems(otherChip)).toEqual(['not for the ESP32']);
    expect(esp32ImageProblems(Buffer.alloc(1000))).toEqual(['not ESP32 firmware']);
    const table = Buffer.from(fw.boot!);
    table[0x8000 - ESP32_BOOT_AT + 32 * 4 + 4]! ^= 1;
    expect(esp32BootProblems(table)).not.toEqual([]);
    expect(esp32BootProblems(fw.boot!.subarray(0, 100))).toEqual(['wrong size']);
  });

  it('finds the version in the marker even after the bare one', () => {
    const data = Buffer.concat([Buffer.from('RHSCREEN-FW:esp32-2432s028:\0xx'), Buffer.from('RHSCREEN-FW:esp32-2432s028:1.2.3\0')]);
    expect(imageMarker(data)).toEqual({ model: 'esp32-2432s028', version: '1.2.3' });
  });
});

describe('the settings sector', () => {
  it('is written the way the firmware reads it', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const sector = settingsSector({
      v: 1,
      ssid: 'Brewery',
      pass: 'p',
      token: 't'.repeat(32),
      hub: 'h',
      name: 'Kitchen',
      imageUrl: 'http://x/api/screens/1/image.jpg',
      interval: 60,
      brightness: 80,
      panel: 5,
    });
    expect(sector.length).toBe(SECTOR);
    expect(sector.subarray(0, 4).toString('latin1')).toBe('RHS1');
    expect(sector[SECTOR - 1]).toBe(0xff);
    expect(readSettingsSector(sector)).toMatchObject({ ssid: 'Brewery', name: 'Kitchen', panel: 5 });
    const damaged = Buffer.from(sector);
    damaged[20]! ^= 1;
    expect(readSettingsSector(damaged)).toBeNull();
    expect(() =>
      settingsSector({ v: 1, ssid: 'x'.repeat(5000), pass: '', token: '', hub: '', name: '', imageUrl: '', interval: 1, brightness: 1 }),
    ).toThrow();
  });
});

describe('esptool', () => {
  const v5 = [
    'esptool v5.6.0',
    'Connected to ESP32 on COM7:',
    'Chip type:          ESP32-D0WD-V3 (revision v3.1)',
    'Features:           Wi-Fi, BT, Dual Core',
    'MAC:                20:50:0d:33:96:0c',
    'Flash Memory Information:',
    'Detected flash size: 4MB',
  ].join('\r\n');
  const v4 = ['esptool.py v4.8.1', 'Chip is ESP32-S3 (QFN56) (revision v0.2)', 'MAC: 7c:df:a1:00:11:22', 'Detected flash size: 8MB'].join(
    '\n',
  );

  it('reads the board from what any version prints', () => {
    expect(parseBoard(v5)).toEqual({ chip: 'esp32', description: 'ESP32-D0WD-V3 (revision v3.1)', mac: '20:50:0d:33:96:0c', flashMb: 4 });
    expect(parseBoard(v4)).toMatchObject({ chip: 'esp32s3', mac: '7c:df:a1:00:11:22', flashMb: 8 });
    expect(parseBoard('Connecting.....')).toBeNull();
    expect(chipFamily('ESP8266EX')).toBe('esp8266');
    expect(chipFamily('ESP32-C3 (QFN32)')).toBe('esp32c3');
  });

  it('says what went wrong', () => {
    expect(esptoolProblem("A fatal error occurred: could not open port 'COM7': PermissionError(13, 'Access is denied.')").code).toBe(
      'busy',
    );
    expect(
      esptoolProblem(
        "A fatal error occurred: Could not open /dev/ttyUSB0, the port is busy or doesn't exist.\n[Errno 16] Device or resource busy",
      ).code,
    ).toBe('busy');
    expect(esptoolProblem("[Errno 13] Permission denied: '/dev/ttyUSB0'").code).toBe('denied');
    expect(esptoolProblem('A fatal error occurred: Failed to connect to ESP32: No serial data received.').code).toBe('no-board');
    expect(esptoolProblem("could not open port 'COM9': FileNotFoundError(2, 'The system cannot find the file specified.')").code).toBe(
      'no-board',
    );
    expect(esptoolProblem('A fatal error occurred: Something odd').message).toBe('Something odd');
  });

  it('follows the progress of a write across its files', () => {
    const p = new WriteProgress([100, 300]);
    expect(p.line('Compressed 100 bytes to 20...')).toBeNull();
    expect(p.line('Writing at 0x00001000 ===== 50.0% 10kB/20kB')).toBe(13);
    expect(p.line('Compressed 300 bytes to 200...')).toBeNull();
    expect(p.line('Writing at 0x00010000... (50 %)')).toBe(63);
    expect(p.line('Writing at 0x00012000 ============ 100.0% 200kB/200kB [27s]')).toBe(100);
  });

  it('reads which screens answered over USB', () => {
    const out = [
      '/dev/ttyUSB0\t{"id":"20500d33960c","model":"esp32-2432s028","fw":"1.1.1","name":"Bar","hub":"h1","claimed":true,"ip":"192.168.50.11"}',
      'Traceback (most recent call last):',
      '/dev/ttyUSB1\t{"id":"not-a-mac"}',
      '',
    ].join('\n');
    expect([...parseWhois(out)]).toEqual([
      ['/dev/ttyUSB0', { id: '20500d33960c', model: 'esp32-2432s028', firmware: '1.1.1', name: 'Bar', hub: 'h1', claimed: true }],
    ]);
  });

  it("says when there's no Python with esptool", async () => {
    const usb = new EsptoolFlasher('rapthooker-no-such-python', silent, async () => []);
    expect(await usb.status()).toEqual({ canSetUp: false, reason: 'no-python', esptool: null, ports: [] });
  });
});

describe('serial ports', () => {
  it("reads Windows' list", () => {
    const one = JSON.stringify({ Name: 'USB-SERIAL CH340 (COM7)', DeviceID: 'USB\\VID_1A86&PID_7523\\6&C1A2E2F&0&1' });
    expect(parseWindowsPorts(one)).toEqual([{ path: 'COM7', name: 'USB-SERIAL CH340 (COM7)', vid: '1a86', pid: '7523', likely: true }]);
    const two = JSON.stringify([
      { Name: 'Communications Port (COM1)', DeviceID: 'ACPI\\PNP0501\\0' },
      { Name: 'Silicon Labs CP210x USB to UART Bridge (COM12)', DeviceID: 'USB\\VID_10C4&PID_EA60\\0001' },
    ]);
    expect(parseWindowsPorts(two).map((p) => [p.path, p.likely])).toEqual([
      ['COM12', true],
      ['COM1', false],
    ]);
    expect(parseWindowsPorts('')).toEqual([]);
  });

  it("reads Linux's from sysfs", async () => {
    const sys = mkdtempSync(join(tmpdir(), 'rapthooker-tty-'));
    try {
      mkdirSync(join(sys, 'ttyUSB0', 'device'), { recursive: true });
      writeFileSync(join(sys, 'ttyUSB0', 'idVendor'), '1a86\n');
      writeFileSync(join(sys, 'ttyUSB0', 'idProduct'), '7523\n');
      writeFileSync(join(sys, 'ttyUSB0', 'product'), 'USB Serial\n');
      writeFileSync(join(sys, 'ttyUSB0', 'manufacturer'), 'QinHeng Electronics\n');
      mkdirSync(join(sys, 'ttyS0'));
      expect(await linuxPorts(sys)).toEqual([
        { path: '/dev/ttyUSB0', name: 'QinHeng Electronics USB Serial', vid: '1a86', pid: '7523', likely: true },
      ]);
    } finally {
      rmSync(sys, { recursive: true, force: true });
    }
  });
});

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function world(opts: ConstructorParameters<typeof MockUsb>[1] = {}) {
  const t = tempStore();
  const fakes: FakeScreen[] = [];
  const usb = new MockUsb(
    async (f) => {
      await f.start();
      fakes.push(f);
    },
    { networks: { Brewery: 'hops-and-barley' }, fetchPictures: false, ...opts },
  );
  const wifi = new MockWifi(() => fakes);
  const screens = new ScreenManager({
    store: t.store,
    settings: new Settings(t.store),
    log: silent,
    wifi,
    usb,
    firmware,
    addresses: async () => [{ kind: 'lan', url: 'http://192.168.50.104:8080' }],
    lookup: async (hostname) => fakes.find((f) => f.online && hostname === `rh-screen-${f.id.slice(-6)}`)?.address ?? null,
    browse: async () => [],
    fast: true,
  });
  screens.load();
  cleanups.push(async () => {
    screens.stop();
    for (const f of fakes) await f.stop();
    t.cleanup();
  });
  return { usb, screens, fakes };
}

function finished(screens: ScreenManager): Promise<ScreenSetupProgress> {
  return new Promise((resolve) => {
    screens.on('setup', (p: ScreenSetupProgress) => {
      if (p.state !== 'running') resolve(p);
    });
  });
}

const input: ScreenUsbSetupInput = {
  port: MockUsb.PORT,
  model: 'esp32-2432s028',
  ssid: 'Brewery',
  password: '',
  name: 'Bar',
  pillId: null,
  look: { palette: 'hops' },
};

async function setUp(screens: ScreenManager, over: Partial<ScreenUsbSetupInput> = {}): Promise<ScreenSetupProgress> {
  const done = finished(screens);
  expect(screens.startUsbSetup({ ...input, ...over }).via).toBe('usb');
  return done;
}

describe('setting a screen up over USB', () => {
  it('writes the firmware and its settings, watches it join and saves it', async () => {
    const { usb, screens } = await world();
    expect((await screens.usbStatus()).ports).toMatchObject([{ path: MockUsb.PORT, likely: true }]);
    const p = await setUp(screens);
    expect(p).toMatchObject({ state: 'done', error: null, via: 'usb', hotspot: MockUsb.PORT, screenId: '025248000032' });
    expect(p.steps.map((s) => s.step)).toEqual(SCREEN_USB_STEPS);
    expect(usb.writes).toEqual([`boot, firmware ${fw.version}, settings`]);
    const fake = usb.screen!;
    expect(fake.settings).toMatchObject({ ssid: 'Brewery', pass: 'hops-and-barley', hub: screens.hubId(), name: 'Bar', panel: 0 });
    expect(fake.settings.imageUrl).toBe(`http://192.168.50.104:8080/api/screens/${fake.id}/image.jpg`);
    expect(fake.settings.token).toMatch(/^[0-9a-f]{32}$/);
    expect(screens.get(fake.id)).toMatchObject({
      name: 'Bar',
      model: 'esp32-2432s028',
      mac: '02:52:48:00:00:32',
      hostname: 'rh-screen-000032',
      ip: fake.address,
      panel: 0,
    });
  });

  it('tells a board that is one of its screens from a new one', async () => {
    const { usb, screens } = await world();
    expect((await screens.usbStatus()).ports[0]!.board).toBeNull();
    await setUp(screens);
    expect((await screens.usbStatus()).ports[0]!.board).toEqual({
      id: usb.screen!.id,
      model: 'esp32-2432s028',
      firmware: fw.version,
      name: 'Bar',
      hub: screens.hubId(),
      claimed: true,
    });
  });

  it('says the password is wrong, then takes the right one', async () => {
    const { usb, screens } = await world();
    const wrong = await setUp(screens, { password: 'lager' });
    expect(wrong).toMatchObject({ state: 'failed', error: 'wrong-password', screenId: null });
    expect(screens.list()).toEqual([]);
    const lost = await setUp(screens, { ssid: 'Cellar', password: 'x' });
    expect(lost).toMatchObject({ state: 'failed', error: 'network-not-found' });
    expect(await setUp(screens)).toMatchObject({ state: 'done' });
    expect(usb.writes).toHaveLength(3);
  });

  it('finds a board by its name on the network when the hub can’t read what it prints', async () => {
    const { screens } = await world({ quiet: true });
    const p = await setUp(screens);
    expect(p).toMatchObject({ state: 'done' });
    expect(p.steps.map((s) => s.step)).toEqual(SCREEN_USB_STEPS);
  });

  it('turns down boards it has no firmware for, and says why it can’t start', async () => {
    const s3 = await world({ chip: 'esp32s3' });
    expect(await setUp(s3.screens)).toMatchObject({ state: 'failed', error: 'wrong-board', detail: 'ESP32S3' });
    expect(s3.usb.writes).toEqual([]);

    const none = await world({ esptool: false });
    expect(await setUp(none.screens)).toMatchObject({ state: 'failed', error: 'no-usb', detail: 'no-esptool' });

    const gone = await world();
    gone.usb.plugged = false;
    expect(await setUp(gone.screens)).toMatchObject({ state: 'failed', error: 'usb-failed' });
    expect(await setUp(gone.screens, { model: 'sdpro-240' })).toMatchObject({ state: 'failed', error: 'not-supported' });
  });

  it('keeps a known screen’s key and panel corrections when it’s set up again', async () => {
    const { usb, screens } = await world();
    await setUp(screens);
    const id = usb.screen!.id;
    const token = usb.screen!.settings.token;
    await screens.patch(id, { panel: SCREEN_PANEL.flip | SCREEN_PANEL.swap });
    expect(usb.screen!.settings.panel).toBe(5);
    expect(await setUp(screens, { name: 'Bar 2' })).toMatchObject({ state: 'done' });
    expect(usb.screen!.settings).toMatchObject({ token, panel: 5, name: 'Bar 2' });
    expect(screens.get(id)).toMatchObject({ name: 'Bar 2', panel: 5 });
  });

  it('shows the test pattern on screens that have one, and has no original firmware to put back', async () => {
    const { usb, screens } = await world();
    await setUp(screens);
    const id = usb.screen!.id;
    await screens.action(id, 'test-pattern');
    expect(usb.screen!.events).toContain('test-pattern');
    await expect(screens.restoreStock(id, Buffer.alloc(10))).rejects.toThrow('no original firmware');
  });
});
