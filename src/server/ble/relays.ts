import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { z } from 'zod';
import type { RelayStatus, relayAdvertSchema } from '@rapthooker/shared';
import type { Logger } from '../log.js';
import { KEG_COMPANY_ID, RAPT_COMPANY_ID } from './rapt.js';
import type { Advert } from './scanner.js';

export type RelayAdvert = z.infer<typeof relayAdvertSchema>;

/** Relays not heard from for this long are dropped from the list. */
const FORGET_MS = 24 * 3_600_000;
/** At most this many relays are listed (names are free text). */
const MAX_RELAYS = 20;
/** A relay's "last heard" is sent to browsers at most this often. */
const STATUS_EVERY_MS = 30_000;

/** Turns a relayed advert into the scanner's Advert, keeping only RAPT manufacturer data. Null if it carries none. */
export function advertFromRelay(r: RelayAdvert, relay: string, at: number, mono: number): Advert | null {
  const entries = Object.entries(r.manufacturerData);
  const manufacturer = new Map<number, Uint8Array>();
  for (const [key, hex] of entries) {
    const companyId = Number(key);
    if (companyId === RAPT_COMPANY_ID || companyId === KEG_COMPANY_ID) manufacturer.set(companyId, Buffer.from(hex, 'hex'));
  }
  // Manufacturer data from something else: not a pill. None at all: only the signal strength.
  if (entries.length > 0 && manufacturer.size === 0) return null;
  const age = r.ageMs ?? 0;
  return {
    address: r.address.toUpperCase(),
    rssi: r.rssi,
    manufacturer: manufacturer.size ? manufacturer : null,
    at: at - age,
    mono: mono - age,
    cached: false,
    source: `relay:${relay}`,
  };
}

/**
 * Bluetooth relays: an ESP32 (ESPHome) or anything else that hears RAPT adverts and posts them to /api/relay. Emits
 * 'advert' (Advert) like a scanner, and 'status' when the list of relays changes (or, at most every 30 s, their activity).
 */
export class RelayHub extends EventEmitter {
  private readonly relays = new Map<string, RelayStatus>();
  private lastStatusAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.prune()) this.emit('status');
    }, 3_600_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Relays heard in the last day, most recent first. */
  list(): RelayStatus[] {
    this.prune();
    return [...this.relays.values()].sort((a, b) => b.lastAt - a.lastAt).map((r) => ({ ...r }));
  }

  /** Feeds adverts posted by a relay into the pipeline. */
  ingest(name: string, adverts: RelayAdvert[]): { accepted: number; ignored: number } {
    const now = this.now();
    const mono = performance.now();
    let accepted = 0;
    for (const r of adverts) {
      const advert = advertFromRelay(r, name, now, mono);
      if (!advert) continue;
      accepted++;
      this.emit('advert', advert);
    }
    let relay = this.relays.get(name);
    const isNew = !relay;
    if (!relay) {
      if (this.relays.size >= MAX_RELAYS) {
        const oldest = [...this.relays.values()].sort((a, b) => a.lastAt - b.lastAt)[0]!;
        this.relays.delete(oldest.name);
      }
      relay = { name, lastAt: now, adverts: 0 };
      this.relays.set(name, relay);
      this.log.info({ relay: name }, 'a Bluetooth relay started posting adverts');
    }
    relay.lastAt = now;
    relay.adverts += accepted;
    if (isNew || now - this.lastStatusAt >= STATUS_EVERY_MS) {
      this.lastStatusAt = now;
      this.emit('status');
    }
    return { accepted, ignored: adverts.length - accepted };
  }

  private prune(): boolean {
    const cutoff = this.now() - FORGET_MS;
    let changed = false;
    for (const [name, r] of this.relays) {
      if (r.lastAt < cutoff) {
        this.relays.delete(name);
        changed = true;
      }
    }
    return changed;
  }
}
