import { multipart, request, ScreenRequestError } from './client.js';
import { stockProblems, type FirmwareImage } from './firmware.js';

/**
 * The stock "SD Pro" firmware on a new "Smart weather clock" screen, reached on its hotspot (192.168.4.1). Its
 * /update_ota installs whatever it's sent, and silently drops everything past 512 KB first, so RaptHooker only ever
 * sends an image that has passed stockProblems, once, to a screen that has been identified.
 */

export interface StockScreen {
  /** AA:BB:CC:DD:EE:FF */
  mac: string;
  title: string;
  model: 'sdpro-240';
}

const CONFIG_KEYS = ['gifnum', 'theme', 'brightness', 'freespace', 'weatherkey', 'ssid'];

/** The screen at `host` if it's a stock SD Pro (its MAC, settings and set-up page all look right), else null. */
export async function identifyStock(host: string, localAddress?: string): Promise<StockScreen | null> {
  try {
    const mac = (await request(host, '/mac', { timeoutMs: 6000, localAddress })).body.toString('utf8').trim().toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return null;
    const config = JSON.parse((await request(host, '/config', { timeoutMs: 6000, localAddress })).body.toString('utf8')) as unknown;
    if (!config || typeof config !== 'object' || !CONFIG_KEYS.every((k) => k in config)) return null;
    const page = (await request(host, '/', { timeoutMs: 6000, localAddress })).body.toString('utf8');
    const title = /<title>([^<]*)<\/title>/i.exec(page)?.[1]?.trim() ?? '';
    if (!/smart weather clock/i.test(title)) return null;
    return { mac, title, model: 'sdpro-240' };
  } catch {
    return null;
  }
}

/**
 * Installs RaptHooker firmware on a stock screen. Once the stock firmware has the image it restarts, copies the new
 * firmware into place (about 5 s, when it mustn't lose power) and starts it. It doesn't always get its "OK" out
 * before restarting, so a connection that drops once the whole image has gone is no answer either way: false, and the
 * caller looks for what comes back. True when it said OK; an error when the image didn't all go, or it said no.
 */
export async function flashStock(host: string, fw: FirmwareImage, localAddress?: string): Promise<boolean> {
  const problems = stockProblems(fw.data, fw.model);
  if (problems.length) throw new Error(`The firmware can't go to this screen: ${problems.join(', ')}`);
  // The stock web page only sends files whose name starts SDP.
  const { body, type } = multipart('update', `SDP-rapthooker-screen-${fw.model}-${fw.version}.bin`, fw.data);
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
  if (res.status !== 200 || text !== 'OK') throw new ScreenRequestError(`the screen said ${res.status} ${text.slice(0, 40)}`, res.status);
  return true;
}
