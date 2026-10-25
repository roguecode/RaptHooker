import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { BleStatus } from '@rapthooker/shared';
import { encodeRaptV2, KEG_COMPANY_ID, RAPT_COMPANY_ID } from './rapt.js';
import type { Advert, Scanner } from './scanner.js';

const DAY = 86_400_000;
const G = 1040;

interface Profile {
  address: string;
  og: number;
  fg: number;
  /** Days into the cycle when fermentation is fastest, and how quickly it happens. */
  mid: number;
  width: number;
  temp: number;
  /** Cycle offset so the pills aren't all at the same stage. */
  offsetDays: number;
  firmware: string;
  /** Typical signal at the hub, dBm (each broadcast varies a little either side). */
  rssi: number;
}

/** Simulated pills for development (addresses are made up). The lager pill is in a fridge, so it's harder to hear. */
export const MOCK_PROFILES: Profile[] = [
  {
    address: 'F0:0D:5E:ED:00:03',
    og: 1.054,
    fg: 1.011,
    mid: 2.2,
    width: 0.55,
    temp: 19,
    offsetDays: 3.1,
    firmware: '20250319_mock_ale',
    rssi: -59,
  },
  {
    address: 'F0:0D:5E:ED:00:04',
    og: 1.048,
    fg: 1.009,
    mid: 5,
    width: 1.2,
    temp: 11,
    offsetDays: 4.4,
    firmware: '20250319_mock_lager',
    rssi: -80,
  },
  {
    address: 'F0:0D:5E:ED:00:05',
    og: 1.0003,
    fg: 1.0003,
    mid: 1,
    width: 1,
    temp: 21,
    offsetDays: 0,
    firmware: '20250319_mock_water',
    rssi: -70,
  },
];

/** A broadcast's signal: the pill's typical strength, give or take 4 dBm. */
export const simulatedRssi = (p: Profile): number => p.rssi + Math.round((Math.random() - 0.5) * 8);

const CYCLE_DAYS = 14;

/** Days since the simulated pill's current fermentation began. */
export function cycleAgeDays(p: Profile, t: number): number {
  return (((t / DAY + p.offsetDays) % CYCLE_DAYS) + CYCLE_DAYS) % CYCLE_DAYS;
}

/** The simulated reading for a pill at time t, so seeded history and live readings line up. */
export function simulate(
  p: Profile,
  t: number,
  noise = true,
): { sg: number; temp: number; velocity: number | null; battery: number; x: number; y: number; z: number } {
  const age = cycleAgeDays(p, t);
  const logistic = 1 / (1 + Math.exp((age - p.mid) / p.width));
  const sg = p.fg + (p.og - p.fg) * logistic;
  const velocity = age < 0.4 ? null : (-(p.og - p.fg) * 1000 * logistic * (1 - logistic)) / p.width;
  const activity = Math.exp(-(((age - p.mid) / (p.width * 2)) ** 2));
  const jitter = () => (noise ? Math.random() - 0.5 : 0);
  const temp = p.temp + 1.4 * activity * (p.og > 1.01 ? 1 : 0) + 0.25 * Math.sin((2 * Math.PI * t) / DAY) + jitter() * 0.12;
  const angle = ((18 + (sg - 0.99) * 900 + jitter() * 0.6) * Math.PI) / 180;
  return {
    sg: sg + jitter() * 0.0003,
    temp,
    velocity,
    battery: Math.max(3, 100 - age * 2.1),
    x: Math.round(G * Math.sin(angle) * 16) / 16,
    y: Math.round(jitter() * 30 * 16) / 16,
    z: Math.round(G * Math.cos(angle) * 16) / 16,
  };
}

/** Pretends to be BlueZ: every pill sends a burst like a real one (its previous reading, then the new one). */
export class MockScanner extends EventEmitter implements Scanner {
  private timers: NodeJS.Timeout[] = [];
  private readonly previous = new Map<string, Buffer>();
  private counts = new Map<string, number>();
  private _status: BleStatus = {
    state: 'mock',
    adapter: 'simulated',
    adapters: ['simulated'],
    mode: null,
    error: null,
    lastAdvertAt: null,
    since: Date.now(),
    relays: [],
  };

  constructor(private readonly intervalMs = 20_000) {
    super();
  }

  get status(): BleStatus {
    return this._status;
  }

  async start(): Promise<void> {
    MOCK_PROFILES.forEach((p, i) => {
      const first = setTimeout(() => this.transmit(p), 1500 + i * 700);
      const every = setInterval(() => this.transmit(p), this.intervalMs + i * 1300);
      this.timers.push(first, every);
    });
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private emitAdvert(address: string, companyId: number, data: Uint8Array, rssi: number): void {
    const at = Date.now();
    this._status = { ...this._status, lastAdvertAt: at };
    this.emit('advert', {
      address,
      rssi,
      manufacturer: new Map([[companyId, data]]),
      at,
      mono: performance.now(),
      cached: false,
      source: 'simulated',
    } satisfies Advert);
  }

  private transmit(p: Profile): void {
    const rssi = simulatedRssi(p);
    const payload = encodeRaptV2(simulate(p, Date.now()));
    const before = this.previous.get(p.address);
    if (before) this.emitAdvert(p.address, RAPT_COMPANY_ID, before, rssi);
    this.emitAdvert(p.address, RAPT_COMPANY_ID, payload, rssi);
    this.emitAdvert(p.address, RAPT_COMPANY_ID, payload, rssi);
    this.previous.set(p.address, payload);
    const n = (this.counts.get(p.address) ?? 0) + 1;
    this.counts.set(p.address, n);
    if (n % 10 === 1) {
      this.emitAdvert(p.address, KEG_COMPANY_ID, Buffer.from(`G${p.firmware}`, 'latin1'), rssi);
      this.emitAdvert(p.address, RAPT_COMPANY_ID, Buffer.from('PTdPillG1', 'latin1'), rssi);
    }
  }
}
