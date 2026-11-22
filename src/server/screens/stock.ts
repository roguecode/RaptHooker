import { screenModel } from '@rapthooker/shared';
import { multipart, request, ScreenRequestError } from './client.js';
import { stockProblems, type FirmwareImage } from './firmware.js';

/**
 * The stock "SD Pro" firmware on a new "Smart weather clock" screen, reached on its hotspot (192.168.4.1). Its
 * /update_ota installs whatever it's sent, and silently drops everything past 512 KB first, so RaptHooker only ever
 * sends an image that has passed stockProblems, once, to a screen that has been identified. Its page only takes files
 * named SDP...: the firmware itself just logs a complaint about any other name, and installs it anyway. A genuine
 * GeekMagic Ultra (its own firmware, further down) is the same hardware, and gets the same image.
 *
 * The SDC2 is the same clock on an ESP32-C2, with the same firmware ported to it: its page asks for files named
 * SDC2..., and it needs RaptHooker's ESP32-C2 image. That's only ever sent to one whose own page says SDC2: sent to an
 * SD Pro, it would be installed, and the clock wouldn't start. The other way round is safe: an SDC2 turns down a file
 * not named SDC2... or not for its chip ("Wrong firmware!").
 */

export interface StockScreen {
  /** AA:BB:CC:DD:EE:FF */
  mac: string;
  title: string;
  kind: 'sdpro' | 'sdc2';
  model: 'sdpro-240' | 'sdc2-240';
}

const CONFIG_KEYS = ['gifnum', 'theme', 'brightness', 'freespace', 'weatherkey', 'ssid'];

/** An SDC2's page, or a script it loads, asks for update files named like this. An SD Pro's never mentions it. */
const SDC2_TEXT = /\bSDC2/;

/** What an SDC2 answers (400 "Wrong firmware!") when it's sent firmware that isn't for it. An SD Pro never says it. */
export class WrongFirmware extends ScreenRequestError {}

/**
 * What an SDC2 says it is at /version ("SDC2 V1.2.0"), or null. An SD Pro has no such page. Only asked of a clock that
 * has turned the SD Pro's firmware down.
 */
export async function sdc2Version(host: string, localAddress?: string): Promise<string | null> {
  try {
    const res = await request(host, '/version', { timeoutMs: 6000, localAddress });
    const text = res.body.toString('utf8').trim();
    return res.status === 200 && /^SDC2 V\d+(\.\d+)*$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Whether the stock page at `host`, or a script from the same place it loads, says SDC2. */
async function saysSdc2(host: string, page: string, localAddress?: string): Promise<boolean> {
  if (SDC2_TEXT.test(page)) return true;
  const scripts = new Set(['/javascript.js']);
  for (const m of page.matchAll(/<script[^>]*\ssrc=["']?\/?([\w./-]+\.js)/gi)) scripts.add(`/${m[1]}`);
  for (const path of [...scripts].slice(0, 4)) {
    const res = await request(host, path, { timeoutMs: 6000, localAddress }).catch(() => null);
    if (res?.status === 200 && SDC2_TEXT.test(res.body.toString('utf8'))) return true;
  }
  return false;
}

/**
 * The screen at `host` if it's a stock Smart weather clock, else null: its MAC, then an SDC2 if its page says so, else
 * an SD Pro if its settings and set-up page look right.
 */
export async function identifyStock(host: string, localAddress?: string): Promise<StockScreen | null> {
  try {
    const mac = (await request(host, '/mac', { timeoutMs: 6000, localAddress })).body.toString('utf8').trim().toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return null;
    const page = (await request(host, '/', { timeoutMs: 6000, localAddress })).body.toString('utf8');
    const title = /<title>([^<]*)<\/title>/i.exec(page)?.[1]?.trim() ?? '';
    if (await saysSdc2(host, page, localAddress)) return { mac, title, kind: 'sdc2', model: 'sdc2-240' };
    const config = JSON.parse((await request(host, '/config', { timeoutMs: 6000, localAddress })).body.toString('utf8')) as unknown;
    if (!config || typeof config !== 'object' || !CONFIG_KEYS.every((k) => k in config)) return null;
    if (!/smart weather clock/i.test(title)) return null;
    return { mac, title, kind: 'sdpro', model: 'sdpro-240' };
  } catch {
    return null;
  }
}

/**
 * Installs RaptHooker firmware on a stock screen (the image for an SD Pro or an SDC2, by its model). Once the stock
 * firmware has the image it restarts, copies the new firmware into place (about 5 s, when it mustn't lose power) and
 * starts it. It doesn't always get its "OK" out before restarting, so a connection that drops once the whole image
 * has gone is no answer either way: false, and the caller looks for what comes back. True when it said OK; an error
 * when the image didn't all go, or it said no.
 */
export async function flashStock(host: string, fw: FirmwareImage, localAddress?: string): Promise<boolean> {
  const problems = stockProblems(fw.data, fw.model);
  if (problems.length) throw new Error(`The firmware can't go to this screen: ${problems.join(', ')}`);
  // The stock web pages only send files whose name starts like this.
  const prefix = screenModel(fw.model)?.chip === 'esp32c2' ? 'SDC2' : 'SDP';
  const { body, type } = multipart('update', `${prefix}-rapthooker-screen-${fw.model}-${fw.version}.bin`, fw.data);
  let res;
  try {
    res = await request(host, '/update_ota', {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
      timeoutMs: 120_000,
      localAddress,
    });
  } catch (err) {
    if (err instanceof ScreenRequestError && err.sent) return false;
    throw err;
  }
  const text = res.body.toString('utf8').trim();
  if (res.status === 200 && text === 'OK') return true;
  const Refusal = /wrong firmware/i.test(text) ? WrongFirmware : ScreenRequestError;
  throw new Refusal(`the screen said ${res.status} ${text.slice(0, 40)}`, res.status);
}

/**
 * A genuine GeekMagic on its own firmware ("GIFTV" when it's new): what it says it is at /v.json, `{"m":
 * "SmallTV-Ultra","v":"Ultra-V9.0.50"}`, or null if what's at `host` doesn't answer like one. Only the Ultra
 * (GEEKMAGIC_ULTRA) has the hardware RaptHooker's firmware is for; the caller checks.
 */
export async function identifyGeekmagic(host: string, localAddress?: string): Promise<{ model: string; version: string } | null> {
  try {
    const res = await request(host, '/v.json', { timeoutMs: 6000, localAddress });
    if (res.status !== 200) return null;
    const v = JSON.parse(res.body.toString('utf8')) as unknown;
    if (!v || typeof v !== 'object') return null;
    const { m, v: version } = v as { m?: unknown; v?: unknown };
    return typeof m === 'string' && m && typeof version === 'string' ? { model: m, version } : null;
  } catch {
    return null;
  }
}

/**
 * Installs RaptHooker firmware on a GeekMagic Ultra through its own update page (POST /update, the Arduino core's
 * updater). Unlike SD Pro's, it refuses what isn't a whole ESP8266 image that fits its flash and the space it has
 * free, rather than installing part of it; it answers "Update Success! Rebooting..." or "Update error: …", then
 * restarts and copies the firmware into place (when it mustn't lose power). A connection that drops once the whole
 * image has gone is no answer either way: false, and the caller looks for what comes back.
 */
export async function flashGeekmagic(host: string, fw: FirmwareImage, localAddress?: string): Promise<boolean> {
  const problems = stockProblems(fw.data, fw.model);
  if (problems.length) throw new Error(`The firmware can't go to this screen: ${problems.join(', ')}`);
  const { body, type } = multipart('firmware', `rapthooker-screen-${fw.model}-${fw.version}.bin`, fw.data);
  let res;
  try {
    res = await request(host, '/update', {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
      timeoutMs: 120_000,
      localAddress,
    });
  } catch (err) {
    if (err instanceof ScreenRequestError && err.sent) return false;
    throw err;
  }
  const text = res.body.toString('utf8');
  if (res.status === 200 && /Update Success/i.test(text)) return true;
  const error = /Update error:\s*([^<\r\n]*)/i.exec(text)?.[1]?.trim();
  throw new ScreenRequestError(`the screen said ${error || `${res.status} ${text.trim().slice(0, 40)}`}`, res.status);
}
