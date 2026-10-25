import { execFile } from 'node:child_process';
import type { Logger } from '../log.js';

/** Runs a program without a shell. Injected in tests. */
export type ExecFn = (file: string, args: string[], opts: { timeout: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

export const execFileAsync: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    try {
      execFile(
        file,
        args,
        { timeout: opts.timeout, env: opts.env, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => (err ? reject(err) : resolve({ stdout })),
      );
    } catch (err) {
      reject(err as Error);
    }
  });

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Tells systemd how the service is doing (Type=notify): ready, watchdog pings, stopping. Node can't write to the
 * notify socket (a Unix datagram socket) itself, so this runs `systemd-notify`. That waits until systemd has handled
 * the message, so with NotifyAccess=all it's credited to this service even though it comes from a child process.
 * Does nothing unless systemd started us (NOTIFY_SOCKET is set): development, Docker and tests.
 */
export class SystemdNotifier {
  readonly enabled: boolean;
  /** The watchdog timeout systemd gave us (WatchdogSec), ms, or null when there's no watchdog. */
  readonly watchdogMs: number | null;
  private failures = 0;

  constructor(
    private readonly log: Logger,
    private readonly exec: ExecFn = execFileAsync,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.enabled = Boolean(env.NOTIFY_SOCKET);
    const usec = Number(env.WATCHDOG_USEC);
    this.watchdogMs = this.enabled && Number.isFinite(usec) && usec > 0 ? usec / 1000 : null;
  }

  /** How often to ping the watchdog: a third of its timeout, at most every 20 s. */
  get pingEveryMs(): number {
    return this.watchdogMs ? Math.max(1000, Math.min(20_000, Math.floor(this.watchdogMs / 3))) : 20_000;
  }

  /** Sends `KEY=value` assignments. Resolves to whether systemd got them; never rejects. */
  async notify(...assignments: string[]): Promise<boolean> {
    if (!this.enabled || assignments.length === 0) return false;
    try {
      await this.exec('systemd-notify', assignments, { timeout: 10_000, env: this.env });
      this.failures = 0;
      return true;
    } catch (err) {
      // Logged a few times only: a missing systemd-notify would otherwise log every 20 s.
      if (this.failures++ < 3) this.log.warn({ err: errorText(err), sent: assignments.join(' ') }, 'systemd-notify failed');
      return false;
    }
  }
}
