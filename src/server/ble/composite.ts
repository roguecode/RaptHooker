import { EventEmitter } from 'node:events';
import type { BleStatus } from '@rapthooker/shared';
import type { RelayHub } from './relays.js';
import type { Advert, Scanner } from './scanner.js';

/** Pills nobody has heard for this long are switched off or gone: the radio isn't expected to hear them. */
const EXPECT_HEARD_WITHIN_MS = 24 * 3_600_000;
/** How much later than the radio's a relay's copy of the same transmission can arrive. */
const SAME_TRANSMISSION_MS = 60_000;
/** Addresses remembered (only pills' adverts reach here, but a relay could post anything). */
const MAX_TRACKED = 256;

/** A pill being recorded, as far as the radio's watchdog needs to know. */
export interface RecordedPill {
  address: string;
  /** Last heard by anyone (the radio or a relay), across restarts. */
  lastHeardAt: number | null;
}

/**
 * The hub's one source of adverts: the Bluetooth scanner (BlueZ, simulated or unavailable) plus any relays posting
 * over HTTP. Both feed the same 'advert' stream, and the status lists the relays alongside the adapters.
 */
export class CompositeScanner extends EventEmitter implements Scanner {
  /** When each address was last heard by the hub's own Bluetooth and by a relay. */
  private readonly heard = new Map<string, { radioAt: number | null; relayAt: number | null }>();

  constructor(
    readonly radio: Scanner,
    readonly relays: RelayHub,
    private readonly now: () => number = Date.now,
  ) {
    super();
    const forward = (advert: Advert) => {
      try {
        this.note(advert);
      } catch {
        // Only bookkeeping for the radio's watchdog: the advert goes on regardless.
      }
      this.emit('advert', advert);
    };
    radio.on('advert', forward);
    relays.on('advert', forward);
    radio.on('status', () => this.emit('status', this.status));
    relays.on('status', () => this.emit('status', this.status));
  }

  private note(advert: Advert): void {
    if (advert.cached) return;
    const address = advert.address.toUpperCase();
    let entry = this.heard.get(address);
    if (!entry) {
      if (this.heard.size >= MAX_TRACKED) {
        const last = (e: { radioAt: number | null; relayAt: number | null }) => Math.max(e.radioAt ?? 0, e.relayAt ?? 0);
        const oldest = [...this.heard].reduce((a, b) => (last(b[1]) < last(a[1]) ? b : a));
        this.heard.delete(oldest[0]);
      }
      entry = { radioAt: null, relayAt: null };
      this.heard.set(address, entry);
    }
    if (advert.source?.startsWith('relay:')) entry.relayAt = Math.max(entry.relayAt ?? 0, advert.at);
    else entry.radioAt = Math.max(entry.radioAt ?? 0, advert.at);
  }

  /**
   * Whether the hub's own Bluetooth ought to be hearing any of these pills (the ones being recorded), for its watchdog
   * to tell a stuck adapter from pills it can't hear anyway: a pill counts if someone heard it in the last day (one
   * that's switched off doesn't), and not if only relays have heard it lately (it's out of the radio's range).
   */
  radioExpects(pills: RecordedPill[]): boolean {
    const now = this.now();
    return pills.some((p) => {
      const heard = this.heard.get(p.address.toUpperCase());
      const last = Math.max(p.lastHeardAt ?? 0, heard?.radioAt ?? 0, heard?.relayAt ?? 0);
      if (now - last > EXPECT_HEARD_WITHIN_MS) return false;
      return !heard || heard.relayAt === null || heard.relayAt - (heard.radioAt ?? 0) <= SAME_TRANSMISSION_MS;
    });
  }

  get status(): BleStatus {
    const radio = this.radio.status;
    const relays = this.relays.list();
    const lastRelayAt = relays.reduce<number | null>((max, r) => (max === null || r.lastAt > max ? r.lastAt : max), null);
    const lastAdvertAt =
      radio.lastAdvertAt === null ? lastRelayAt : lastRelayAt === null ? radio.lastAdvertAt : Math.max(radio.lastAdvertAt, lastRelayAt);
    return { ...radio, lastAdvertAt, relays };
  }

  async start(): Promise<void> {
    this.relays.start();
    await this.radio.start();
  }

  async stop(): Promise<void> {
    this.relays.stop();
    await this.radio.stop();
  }
}
