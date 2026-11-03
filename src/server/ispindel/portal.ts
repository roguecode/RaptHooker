import { decodeHtmlEntities } from '@rapthooker/shared';
import { request } from '../screens/client.js';

/**
 * Talking to an iSpindel's setup portal (the page it serves on its own hotspot, at 192.168.4.1): a WiFiManager form
 * that's sent as a GET to /wifisave. Saving replaces every setting with what's sent (a missing one is emptied), so the
 * form is read first and sent back whole, with only what RaptHooker needs changed. Checkboxes are sent only when
 * ticked, as a browser would.
 */

export interface PortalField {
  name: string;
  value: string;
  type: string;
  checked: boolean;
}

export interface PortalForm {
  fields: PortalField[];
  /** The service types it offers, by the number it saves them as (selAPI). */
  services: string[];
}

/** An HTML tag's attributes ("checked" alone counts as present). */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  // Skip the tag name.
  const body = tag.replace(/^<\s*[a-zA-Z]+/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(re)) out.set(m[1]!.toLowerCase(), decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  return out;
}

/** The form on the portal's Configuration page (/wifi), and its list of services. */
export function parsePortalForm(html: string): PortalForm {
  const start = html.search(/<form[^>]*action\s*=\s*["']?\/?wifisave/i);
  const end = start === -1 ? -1 : html.indexOf('</form>', start);
  const form = start === -1 ? '' : html.slice(start, end === -1 ? undefined : end);
  const fields: PortalField[] = [];
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const name = a.get('name');
    if (!name) continue;
    fields.push({ name, value: a.get('value') ?? '', type: (a.get('type') ?? 'text').toLowerCase(), checked: a.has('checked') });
  }
  // The service list is a script array whose order gives each service's number: var lAPI = [{"name":"Ubidots",...}, ...].
  const list = /var\s+lAPI\s*=\s*\[([\s\S]*?)\];/.exec(html)?.[1] ?? '';
  const services = [...list.matchAll(/"name"\s*:\s*"([^"]*)"/g)].map((m) => m[1]!);
  return { fields, services };
}

/** An iSpindel's portal (rather than some other device's WiFiManager page): it has the iSpindel's own settings. */
export function isIspindelForm(form: PortalForm): boolean {
  const names = new Set(form.fields.map((f) => f.name));
  return names.has('s') && names.has('selAPI') && names.has('POLYN') && names.has('token') && names.has('server');
}

export const fieldValue = (form: PortalForm, name: string): string | null => form.fields.find((f) => f.name === name)?.value ?? null;

/** The number it saves the HTTP service as: 3 on every iSpindel firmware so far, but read from the page to be sure. */
export function httpServiceNumber(form: PortalForm): number {
  const i = form.services.findIndex((s) => s.trim().toUpperCase() === 'HTTP');
  return i === -1 ? 3 : i;
}

/**
 * What to send to /wifisave: every field as the form has it, with `changes` in place of theirs. Ticked boxes are sent
 * with their value; others aren't sent at all (so the iSpindel reads them as unticked). Names in `untick` are left
 * out even if ticked.
 */
export function saveParams(form: PortalForm, changes: Record<string, string>, untick: string[] = []): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const f of form.fields) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    if (f.type === 'checkbox') {
      if (f.checked && !untick.includes(f.name)) out.push([f.name, f.value || 'checked']);
      continue;
    }
    out.push([f.name, changes[f.name] ?? f.value]);
  }
  for (const [name, value] of Object.entries(changes)) if (!seen.has(name)) out.push([name, value]);
  return out;
}

export const query = (params: [string, string][]): string =>
  params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

export class PortalError extends Error {}

/** Reads the Configuration page of the portal at `host` (192.168.4.1, or a pretend iSpindel's address in tests). */
export async function readPortal(host: string, localAddress?: string): Promise<PortalForm> {
  const res = await request(host, '/wifi', { timeoutMs: 15_000, localAddress });
  if (res.status !== 200) throw new PortalError(`The setup page answered ${res.status}`);
  return parsePortalForm(res.body.toString('utf8'));
}

/** Saves the settings; the iSpindel then leaves setup mode, restarts and joins its Wi-Fi. */
export async function savePortal(host: string, params: [string, string][], localAddress?: string): Promise<void> {
  const res = await request(host, `/wifisave?${query(params)}`, { timeoutMs: 15_000, localAddress });
  if (res.status !== 200) throw new PortalError(`Saving answered ${res.status}`);
  if (!/Credentials Saved|Saved/i.test(res.body.toString('utf8'))) throw new PortalError("It didn't say the settings were saved");
}
