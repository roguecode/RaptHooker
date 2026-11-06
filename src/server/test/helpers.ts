import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Store } from '../db.js';
import { IspindelService } from '../ispindel/service.js';
import type { PillService } from '../pills.js';
import { ScreenManager } from '../screens/manager.js';
import { NoUsb } from '../screens/usb/types.js';
import { NoWifi, type WifiController } from '../screens/wifi/types.js';
import type { Settings } from '../settings.js';
import type { TokenService } from '../tokens.js';

export const silent = pino({ level: 'silent' });

/** An iSpindel service with no Wi-Fi control (and no hotspots), for tests about other things. */
export function testIspindel(
  store: Store,
  tokens: TokenService,
  pills: PillService,
  opts: { wifi?: WifiController; addresses?: () => Promise<{ kind: 'lan'; url: string }[]>; fast?: boolean; now?: () => number } = {},
): IspindelService {
  return new IspindelService({
    store,
    tokens,
    pills,
    wifi: opts.wifi ?? new NoWifi('off'),
    addresses: opts.addresses ?? (async () => [{ kind: 'lan', url: 'http://192.168.1.20:8080' }]),
    screensBusy: () => false,
    log: silent,
    fast: opts.fast,
    now: opts.now,
  });
}

/** A screens service with no screens and no Wi-Fi control, for tests about other things. */
export function testScreens(store: Store, settings: Settings): ScreenManager {
  return new ScreenManager({
    store,
    settings,
    log: silent,
    wifi: new NoWifi('off'),
    usb: new NoUsb('off'),
    firmware: new Map(),
    addresses: async () => [],
    lookup: async () => null,
    browse: async () => [],
  });
}

export function tempStore(): { store: Store; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rapthooker-test-'));
  const store = new Store(join(dir, 'test.db'));
  return {
    store,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Real payloads captured from a RAPT Pill (manufacturer data after the company id). */
export const CAPTURED = {
  metricsFalling: '5054020001bc09485c929b4483d4ae291b3203f79e6400',
  metricsRising: '50540200013e7ddf07929b4483d26d291d31f6f7b36400',
  /** Lying on its side out of liquid: the gravity it works out from its tilt is meaningless (0.2057). */
  metricsOutOfLiquid: '5054020001434f6dd6900b434dbd57415dfed102346400',
  firmware: '4732303235303331395f3035353534325f62333738386261',
  deviceType: '50546450696c6c4731',
  /** A RAPT Bluetooth Thermometer's iBeacon (after Apple's company id), at rest: 15.3 °C by the RAPT app. */
  thermometerRest: '02154b6567b722314977852625b74c616e64481d400000',
  /** In warm water (32.4 °C) and iced water (0.0 °C) by the RAPT app. */
  thermometerWarm: '02154b6567b722314977852625b74c616e644c63400000',
  thermometerIced: '02154b6567b722314977852625b74c616e64444a400000',
};

/**
 * Real posts from an iSpindel on firmware 6.5.1 (HTTP service), lying flat on a table. The first came straight after
 * it was set up (it says its interval is 1 then), the second 2.4 s later. Its User-Agent was ESP8266HTTPClient.
 */
export const CAPTURED_ISPINDEL = {
  afterSetup:
    '{"name":"2-yolandi_[SG]","ID":6592575,"token":"test-token","angle":87.64426,"temperature":16.5625,"temp_units":"C","battery":4.134515,"gravity":1.11283,"interval":1,"RSSI":-56}',
  flat: '{"name":"2-yolandi_[SG]","ID":6592575,"token":"test-token","angle":87.60577,"temperature":16.5625,"temp_units":"C","battery":4.129301,"gravity":1.112757,"interval":30,"RSSI":-53}',
};
