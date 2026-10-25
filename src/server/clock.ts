import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/** systemd-timesyncd creates this once the clock has been set from the network. */
export const TIMESYNC_FILE = '/run/systemd/timesync/synchronized';
/** Any earlier "now" is certainly a stale clock. */
const PLAUSIBLE_AFTER = Date.UTC(2026, 0, 1);

export interface ClockOptions {
  /** File whose existence means the clock is synced, or null when the clock can be trusted as it is. */
  syncFile: string | null;
  maxWaitMs: number;
  exists?: (path: string) => boolean;
  now?: () => number;
  mono?: () => number;
}

/**
 * A Raspberry Pi has no real-time clock, so it boots with the time it last saved until NTP syncs. Until the clock is
 * trusted, readings are timestamped from the monotonic clock and given wall times once it is (or once we give up
 * waiting), so history never gets readings filed under the wrong time.
 */
export class ClockGuard extends EventEmitter {
  private _trusted: boolean;
  private timer: NodeJS.Timeout | undefined;
  private readonly startedMono: number;
  private readonly exists: (path: string) => boolean;
  private readonly now: () => number;
  private readonly mono: () => number;

  constructor(private readonly opts: ClockOptions) {
    super();
    this.exists = opts.exists ?? existsSync;
    this.now = opts.now ?? Date.now;
    this.mono = opts.mono ?? (() => performance.now());
    this.startedMono = this.mono();
    this._trusted = this.isSynced();
  }

  static forPlatform(maxWaitMs: number): ClockGuard {
    const systemd = process.platform === 'linux' && existsSync('/run/systemd/timesync');
    return new ClockGuard({ syncFile: systemd ? TIMESYNC_FILE : null, maxWaitMs });
  }

  get trusted(): boolean {
    return this._trusted;
  }

  private isSynced(): boolean {
    if (this.now() < PLAUSIBLE_AFTER) return false;
    return this.opts.syncFile === null || this.exists(this.opts.syncFile);
  }

  start(): void {
    if (this._trusted) return;
    this.timer = setInterval(() => this.check(), 2000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Re-checks the sync state; emits 'trusted' when the clock becomes usable. */
  check(): boolean {
    if (this._trusted) return true;
    const gaveUp = this.mono() - this.startedMono > this.opts.maxWaitMs;
    if (this.isSynced() || gaveUp) {
      this._trusted = true;
      clearInterval(this.timer);
      this.emit('trusted', { synced: !gaveUp });
    }
    return this._trusted;
  }

  /** When this process started, by the wall clock. Only right once the clock is trusted. */
  get startedAt(): number {
    return this.wallTime(this.startedMono);
  }

  /** Wall-clock time of something that happened at monotonic time `mono`. */
  wallTime(mono: number): number {
    return Math.round(this.now() - (this.mono() - mono));
  }
}
