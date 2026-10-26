import { EventEmitter } from 'node:events';
import type { BleStatus } from '@rapthooker/shared';
import type { RelayHub } from './relays.js';

export interface Advert {
  /** AA:BB:CC:DD:EE:FF */
  address: string;
  rssi: number | null;
  /**
   * Manufacturer data by company id, or null when only the signal strength changed. With both null the device was only
   * heard again: BlueZ's monitor reports every advert, but only passes on data and signal strength when they change.
   */
  manufacturer: Map<number, Uint8Array> | null;
  /** Wall-clock time it was heard. */
  at: number;
  /** performance.now() when it was heard, for re-stamping once the clock is synced. */
  mono: number;
  /** Read from BlueZ's device cache at start-up rather than heard just now. */
  cached: boolean;
  /** Where it was heard: an adapter (hci0) or a relay ("relay:kitchen"). */
  source?: string;
}

export interface Scanner extends EventEmitter {
  readonly status: BleStatus;
  /** Bluetooth relays (an ESP32...) posting adverts over HTTP, when this scanner accepts them. */
  readonly relays?: RelayHub;
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'advert', listener: (advert: Advert) => void): this;
  on(event: 'status', listener: (status: BleStatus) => void): this;
}

/** For machines without BlueZ: the app runs, but no pills are heard. */
export class UnavailableScanner extends EventEmitter implements Scanner {
  readonly status: BleStatus;

  constructor(reason: string) {
    super();
    this.status = {
      state: 'unavailable',
      adapter: null,
      adapters: [],
      mode: null,
      error: reason,
      lastAdvertAt: null,
      since: Date.now(),
      relays: [],
    };
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}
