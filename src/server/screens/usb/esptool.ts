import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsbBoardId, UsbPort, UsbStatus } from '@rapthooker/shared';
import type { Logger } from '../../log.js';
import { listPorts } from './ports.js';
import { UsbError, type FlashRegion, type UsbBoard, type UsbFlasher } from './types.js';

/** Where deploy/pi/setup.d/50-screens.sh installs esptool (Debian's package lacks the ESP32 stub loader). */
export const PI_PYTHON = '/usr/local/lib/rapthooker/esptool/bin/python3';
/** CH340 boards drop bytes faster than this. */
const BAUD = '230400';
const PROBE = 'import esptool, serial; print(esptool.__version__)';
/** Restarts the board (EN low through RTS, GPIO0 left high through DTR: a normal start) and copies what it prints. */
export const MONITOR = [
  'import sys, time, serial',
  's = serial.Serial()',
  's.port = sys.argv[1]',
  's.baudrate = 115200',
  's.timeout = 0.2',
  's.dtr = False',
  's.rts = False',
  's.open()',
  's.rts = True',
  'time.sleep(0.1)',
  's.rts = False',
  'end = time.time() + float(sys.argv[2])',
  'out = sys.stdout.buffer',
  'while time.time() < end:',
  '    d = s.read(1024)',
  '    if d:',
  '        out.write(d)',
  '        out.flush()',
  's.close()',
].join('\n');

/**
 * Asks the boards on the ports given which screen they are ("?RHSCREEN"), all at once, and prints "<port>\t<json>" for
 * each that answers. Opening a port mustn't restart the board: Linux raises DTR and RTS as it opens one, and changing
 * either from there trips the boards' auto-reset wiring, so on Linux (and macOS) both stay raised; Windows leaves them
 * low, so they stay low there.
 */
export const WHOIS = [
  'import sys, time, serial',
  'ms = float(sys.argv[1])',
  "up = sys.platform != 'win32'",
  'ports = {}',
  'for p in sys.argv[2:]:',
  '    s = serial.Serial()',
  '    s.port = p',
  '    s.baudrate = 115200',
  '    s.timeout = 0',
  '    s.dtr = up',
  '    s.rts = up',
  '    try:',
  '        s.open()',
  '    except Exception:',
  '        continue',
  "    ports[p] = [s, b'']",
  'def ask():',
  '    for s, _ in ports.values():',
  '        try:',
  "            s.write(b'\\n?RHSCREEN\\n')",
  '        except Exception:',
  '            pass',
  'ask()',
  'start = time.time()',
  'again = False',
  'while ports and time.time() - start < ms:',
  '    for p in list(ports):',
  '        s = ports[p][0]',
  '        try:',
  '            ports[p][1] += s.read(4096)',
  '        except Exception:',
  '            s.close()',
  '            del ports[p]',
  '            continue',
  '        buf = ports[p][1]',
  "        i = buf.find(b'RHSCREEN-ID ')",
  "        j = buf.find(b'\\n', i) if i >= 0 else -1",
  '        if j >= 0:',
  "            print(p + '\\t' + buf[i + 12:j].decode('utf-8', 'replace').strip(), flush=True)",
  '            s.close()',
  '            del ports[p]',
  '    if not again and time.time() - start > ms / 2:',
  '        ask()',
  '        again = True',
  '    time.sleep(0.02)',
  'for s, _ in ports.values():',
  '    s.close()',
].join('\n');

/** The boards that answered, from the WHOIS script's output. */
export function parseWhois(out: string): Map<string, UsbBoardId> {
  const found = new Map<string, UsbBoardId>();
  for (const line of out.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    try {
      const d = JSON.parse(line.slice(tab + 1)) as Record<string, unknown>;
      if (typeof d.id !== 'string' || !/^[0-9a-f]{12}$/.test(d.id)) continue;
      const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
      found.set(line.slice(0, tab), {
        id: d.id,
        model: str('model'),
        firmware: str('fw'),
        name: str('name'),
        hub: str('hub'),
        claimed: d.claimed === true,
      });
    } catch {}
  }
  return found;
}

interface Run {
  code: number | null;
  out: string;
  /** It couldn't start (no such program). */
  missing: boolean;
}

/** Runs a program, passing each line of its output to onLine (true stops it). */
function run(argv: string[], args: string[], timeoutMs: number, onLine?: (line: string) => boolean): Promise<Run> {
  return new Promise((resolve) => {
    let out = '';
    let partial = '';
    let done = false;
    // From a folder it can read: esptool looks for an esptool.cfg in the one it starts in.
    const child = spawn(argv[0]!, [...argv.slice(1), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: tmpdir() });
    const decoder = new TextDecoder('utf-8');
    const finish = (r: Run) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const feed = (chunk: Buffer) => {
      const text = decoder.decode(chunk, { stream: true });
      out += text;
      if (out.length > 200_000) out = out.slice(-100_000);
      if (!onLine) return;
      const lines = (partial + text).split(/\r\n|\r|\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (onLine(line)) {
          child.kill();
          return;
        }
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err: NodeJS.ErrnoException) => finish({ code: null, out: err.message, missing: err.code === 'ENOENT' }));
    child.on('close', (code) => finish({ code, out, missing: false }));
  });
}

/** esptool's chip family from what it calls the chip: "ESP32-D0WD-V3 (revision v3.1)" is an esp32. */
export function chipFamily(description: string): string {
  const d = description.toLowerCase();
  const m = /^esp32-(s2|s3|c2|c3|c5|c6|c61|h2|p4)\b/.exec(d);
  if (m) return `esp32${m[1]}`;
  if (d.startsWith('esp8266') || d.startsWith('esp8285')) return 'esp8266';
  if (d.startsWith('esp32')) return 'esp32';
  return d.split(/[\s(]/)[0] ?? d;
}

/** The board, from esptool's output (version 3 to 5 word it differently). */
export function parseBoard(out: string): UsbBoard | null {
  const description = /(?:Chip is|Chip type:)\s*([^\r\n]+)/.exec(out)?.[1]?.trim();
  const mac = /^MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/im.exec(out)?.[1]?.toLowerCase();
  if (!description || !mac) return null;
  const flash = /Detected flash size:\s*(\d+)\s*MB/i.exec(out);
  return { chip: chipFamily(description), description, mac, flashMb: flash ? Number(flash[1]) : null };
}

/** What went wrong, from esptool's output. */
export function esptoolProblem(out: string): UsbError {
  const fatal = /(?:A fatal error occurred|ERROR):\s*([^\r\n]+)/.exec(out)?.[1]?.trim();
  const last =
    fatal ??
    out
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .pop() ??
    'esptool failed';
  if (/No such file or directory|FileNotFoundError|could not find|does not exist/i.test(out)) {
    return new UsbError('no-board', 'The port has gone: the board was unplugged');
  }
  if (/Permission denied|Errno 13\]/i.test(out) && !/Access is denied/i.test(out)) return new UsbError('denied', last);
  if (/could not open port|Access is denied|resource busy|Errno 16/i.test(out)) return new UsbError('busy', last);
  if (/Failed to connect|No serial data received|Wrong boot mode|Invalid head of packet|Timed out waiting/i.test(out)) {
    return new UsbError('no-board', last);
  }
  return new UsbError('failed', last);
}

/** Overall progress through a write, from esptool's "Compressed â€¦" (a file starting) and "Writing at â€¦ 42%" lines. */
export class WriteProgress {
  private index = -1;
  private readonly total: number;
  constructor(private readonly sizes: number[]) {
    this.total = sizes.reduce((a, b) => a + b, 0) || 1;
  }
  /** The percent so far after this line, or null if it says nothing about it. */
  line(line: string): number | null {
    if (/^Compressed \d+ bytes/.test(line.trim())) this.index++;
    const m = /Writing at 0x[0-9a-f]+.*?(\d+(?:\.\d+)?)\s?%/i.exec(line);
    if (!m || this.index < 0) return null;
    const before = this.sizes.slice(0, this.index).reduce((a, b) => a + b, 0);
    const now = ((this.sizes[this.index] ?? 0) * Number(m[1])) / 100;
    return Math.min(100, Math.round(((before + now) / this.total) * 100));
  }
}

type Found = { python: string[]; version: string } | { reason: string };

/**
 * Boards over USB through esptool (and pyserial, to watch the board start): run as `python -m esptool`, from the
 * Python the config names, the Pi set-up's own, or whichever is on the path.
 */
export class EsptoolFlasher implements UsbFlasher {
  readonly name = 'esptool';
  private found: { at: number; result: Found } | null = null;
  /** A whois in progress: another asks the same, and esptool waits for it to let go of the ports. */
  private asking: Promise<Map<string, UsbBoardId>> | null = null;

  constructor(
    private readonly python: string,
    private readonly log: Logger,
    private readonly portList: () => Promise<UsbPort[]> = listPorts,
  ) {}

  /** The Python with esptool, looked for again after a minute (it may have been installed since). */
  private async find(): Promise<Found> {
    if (this.found && Date.now() - this.found.at < 60_000) return this.found.result;
    const candidates = this.python
      ? [this.python.split(' ').filter(Boolean)]
      : [[PI_PYTHON], ['python3'], ['python'], ...(process.platform === 'win32' ? [['py', '-3']] : [])];
    let result: Found = { reason: 'no-python' };
    for (const python of candidates) {
      const r = await run(python, ['-c', PROBE], 20_000);
      if (r.missing) continue;
      const version = r.out.trim().split(/\r?\n/).pop() ?? '';
      if (r.code === 0 && /^\d+\.\d+/.test(version)) {
        result = { python, version };
        break;
      }
      if (/No module named .?serial/i.test(r.out)) result = { reason: 'no-pyserial' };
      else if (/No module named/i.test(r.out) || r.code !== null) result = { reason: 'no-esptool' };
    }
    this.found = { at: Date.now(), result };
    if ('reason' in result) this.log.debug({ reason: result.reason }, 'no esptool for USB set-up');
    return result;
  }

  async status(): Promise<UsbStatus> {
    const [found, ports] = await Promise.all([this.find(), this.ports()]);
    return 'reason' in found
      ? { canSetUp: false, reason: found.reason, esptool: null, ports }
      : { canSetUp: true, reason: null, esptool: found.version, ports };
  }

  ports(): Promise<UsbPort[]> {
    return this.portList().catch(() => []);
  }

  private async esptool(): Promise<{ python: string[]; v5: boolean }> {
    const found = await this.find();
    if ('reason' in found) throw new UsbError('failed', `esptool isn't installed (${found.reason})`);
    return { python: found.python, v5: Number(found.version.split('.')[0]) >= 5 };
  }

  async identify(port: string): Promise<UsbBoard> {
    await this.asking?.catch(() => undefined);
    const { python, v5 } = await this.esptool();
    const r = await run(python, ['-m', 'esptool', '--port', port, '--baud', BAUD, v5 ? 'flash-id' : 'flash_id'], 60_000);
    const board = parseBoard(r.out);
    if (r.code !== 0 || !board) throw esptoolProblem(r.out);
    return board;
  }

  async write(port: string, regions: FlashRegion[], onProgress: (percent: number) => void): Promise<void> {
    const { python, v5 } = await this.esptool();
    const dir = await mkdtemp(join(tmpdir(), 'rapthooker-usb-'));
    try {
      const files: string[] = [];
      for (const [i, r] of regions.entries()) {
        const file = join(dir, `${i}.bin`);
        await writeFile(file, r.data);
        files.push(`0x${r.at.toString(16)}`, file);
      }
      // Underscores for esptool before 5, hyphens after (5 still takes underscores, with a warning each).
      const o = (name: string) => (v5 ? name.replace(/_/g, '-') : name);
      const args = ['-m', 'esptool', '--chip', 'esp32', '--port', port, '--baud', BAUD, '--after', o('no_reset'), o('write_flash')];
      args.push(o('--flash_mode'), 'keep', o('--flash_freq'), 'keep', o('--flash_size'), 'keep', ...files);
      const progress = new WriteProgress(regions.map((r) => r.data.length));
      let shown = -1;
      const r = await run(python, args, 10 * 60_000, (line) => {
        const p = progress.line(line);
        if (p !== null && p !== shown) onProgress((shown = p));
        return false;
      });
      if (r.code !== 0) throw esptoolProblem(r.out);
      this.log.info({ port, regions: regions.map((x) => `${x.name}@0x${x.at.toString(16)}`) }, 'firmware written over USB');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  whois(ports: string[]): Promise<Map<string, UsbBoardId>> {
    if (this.asking) return this.asking;
    const ask = async () => {
      const found = await this.find();
      if ('reason' in found || !ports.length) return new Map<string, UsbBoardId>();
      const r = await run(found.python, ['-c', WHOIS, '1.5', ...ports], 15_000);
      return parseWhois(r.out);
    };
    this.asking = ask().finally(() => {
      this.asking = null;
    });
    return this.asking;
  }

  async watch(port: string, ms: number, onLine: (line: string) => boolean): Promise<boolean> {
    const found = await this.find();
    if ('reason' in found) return false;
    const r = await run(found.python, ['-c', MONITOR, port, String(ms / 1000)], ms + 10_000, onLine);
    if (r.missing || (r.code !== 0 && r.code !== null && /Traceback|Error/.test(r.out))) {
      this.log.warn({ port, out: r.out.slice(-300) }, "couldn't watch the board start");
      return false;
    }
    return true;
  }
}
