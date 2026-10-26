import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Store } from '../db.js';

export const silent = pino({ level: 'silent' });

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
