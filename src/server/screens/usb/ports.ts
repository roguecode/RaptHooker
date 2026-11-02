import { execFile } from 'node:child_process';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UsbPort } from '@rapthooker/shared';

/** USB-to-serial chips ESP32 boards use (vendor:product), and the ESP32-S2/S3/C3's own USB. */
const BOARD_CHIPS = new Set([
  '1a86:7523', // CH340
  '1a86:5523', // CH341
  '1a86:55d3', // CH343
  '1a86:55d4', // CH9102
  '10c4:ea60', // CP210x
  '0403:6001', // FT232R
  '0403:6010', // FT2232
  '0403:6015', // FT231X
  '303a:1001', // Espressif USB JTAG/serial
  '303a:0002', // Espressif USB CDC
]);

export const likelyBoard = (vid: string | null, pid: string | null): boolean =>
  !!vid && !!pid && BOARD_CHIPS.has(`${vid.toLowerCase()}:${pid.toLowerCase()}`);

const byPath = (a: UsbPort, b: UsbPort) => Number(b.likely) - Number(a.likely) || a.path.localeCompare(b.path, 'en', { numeric: true });

/** Windows: what Get-CimInstance says about COM ports (one object or a list, as ConvertTo-Json gives it). */
export function parseWindowsPorts(json: string): UsbPort[] {
  let list: unknown;
  try {
    list = JSON.parse(json.trim() || '[]');
  } catch {
    return [];
  }
  const items = (Array.isArray(list) ? list : [list]) as ({ Name?: string; DeviceID?: string } | null)[];
  const out: UsbPort[] = [];
  for (const item of items) {
    const path = /\((COM\d+)\)/.exec(item?.Name ?? '')?.[1];
    if (!item || !path) continue;
    const vid = /VID_([0-9A-F]{4})/i.exec(item.DeviceID ?? '')?.[1]?.toLowerCase() ?? null;
    const pid = /PID_([0-9A-F]{4})/i.exec(item.DeviceID ?? '')?.[1]?.toLowerCase() ?? null;
    out.push({ path, name: item.Name!, vid, pid, likely: likelyBoard(vid, pid) });
  }
  return out.sort(byPath);
}

function windowsPorts(): Promise<UsbPort[]> {
  const script = 'Get-CimInstance Win32_PnPEntity -Filter "Name LIKE \'%(COM%\'" | Select-Object Name,DeviceID | ConvertTo-Json -Compress';
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      (err, out) => resolve(err ? [] : parseWindowsPorts(out)),
    ),
  );
}

/** Linux: USB serial ports (ttyUSB*, ttyACM*), with the USB device's ids and name from sysfs. */
export async function linuxPorts(sys = '/sys/class/tty'): Promise<UsbPort[]> {
  let names: string[];
  try {
    names = (await readdir(sys)).filter((n) => /^tty(USB|ACM)\d+$/.test(n));
  } catch {
    return [];
  }
  const out: UsbPort[] = [];
  for (const n of names) {
    let vid: string | null = null;
    let pid: string | null = null;
    let label = n;
    try {
      // The tty's device is a USB interface; the USB device with the ids is a folder or two up.
      let dir = await realpath(join(sys, n, 'device'));
      for (let i = 0; i < 4 && dir !== dirname(dir); i++, dir = dirname(dir)) {
        const id = await readFile(join(dir, 'idVendor'), 'utf8').catch(() => null);
        if (id === null) continue;
        vid = id.trim();
        pid = (await readFile(join(dir, 'idProduct'), 'utf8')).trim();
        const product = (await readFile(join(dir, 'product'), 'utf8').catch(() => '')).trim();
        const maker = (await readFile(join(dir, 'manufacturer'), 'utf8').catch(() => '')).trim();
        label = [maker, product].filter(Boolean).join(' ') || n;
        break;
      }
    } catch {}
    out.push({ path: `/dev/${n}`, name: label, vid, pid, likely: likelyBoard(vid, pid) });
  }
  return out.sort(byPath);
}

/** macOS: no ids without IOKit, but the names say what they are. */
async function macPorts(): Promise<UsbPort[]> {
  const names = await readdir('/dev').catch(() => [] as string[]);
  return names
    .filter((n) => /^cu\.(usbserial|usbmodem|wchusbserial|SLAB_USBtoUART)/.test(n))
    .map((n) => ({ path: `/dev/${n}`, name: n.slice(3), vid: null, pid: null, likely: true }))
    .sort(byPath);
}

/** The hub's serial ports a board could be on, likely boards first. */
export function listPorts(platform: NodeJS.Platform = process.platform): Promise<UsbPort[]> {
  if (platform === 'win32') return windowsPorts();
  if (platform === 'darwin') return macPorts();
  return linuxPorts();
}
