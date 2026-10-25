import type { LogEntry, LogLevel } from '@rapthooker/shared';

const LEVELS: Record<number, LogLevel> = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' };
const SKIP = new Set(['level', 'time', 'msg', 'svc', 'pid', 'hostname', 'v']);

/** Keeps the last few hundred log lines in memory for the log viewer. Pass it to pino as a stream. */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly size = 500) {}

  write(line: string): void {
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !SKIP.has(k)));
      this.entries.push({
        at: typeof o.time === 'number' ? o.time : Date.now(),
        level: LEVELS[Number(o.level)] ?? 'info',
        msg: typeof o.msg === 'string' ? o.msg : '',
        svc: typeof o.svc === 'string' ? o.svc : null,
        detail: Object.keys(rest).length ? JSON.stringify(rest) : null,
      });
      if (this.entries.length > this.size) this.entries.splice(0, this.entries.length - this.size);
    } catch {
      // Not a JSON log line.
    }
  }

  /** Newest last; `min` filters by level. */
  list(min: LogLevel = 'debug', limit = this.size): LogEntry[] {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const floor = order.indexOf(min);
    return this.entries.filter((e) => order.indexOf(e.level) >= floor).slice(-limit);
  }
}
