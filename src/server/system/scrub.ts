/**
 * Takes personal and secret details out of text that's going into a diagnostics bundle: Bluetooth addresses, IP
 * addresses, web addresses (paths and queries hold webhook tokens), emails, tokens and passwords, home folders, the
 * hostname, and the names people gave their pills, webhooks and so on.
 */

/** Hosts that are the same for everyone, so they're kept to help with debugging. Paths and queries never are. */
const PUBLIC_HOSTS = new Set([
  'log.brewfather.net',
  'api.brewfather.app',
  'community.grainfather.com',
  'log.brewersfriend.com',
  'brew-spy.com',
  'brewbricks.com',
  'industrial.api.ubidots.com',
  'api.thingspeak.com',
  'discord.com',
  'discordapp.com',
  'ntfy.sh',
  'api.pushover.net',
  'api.telegram.org',
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'smtp.gmail.com',
  'smtp.office365.com',
  'example.com',
]);
/** Shared services whose subdomains can be personal (bucket and account names): shown as *.domain. */
const PUBLIC_SUFFIXES = ['amazonaws.com', 'r2.cloudflarestorage.com', 'backblazeb2.com', 'wasabisys.com', 'digitaloceanspaces.com'];

export const REDACTED = '<redacted>';

const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/[^\s"'<>`\\]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const AUTH_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const SECRET_KEY_RE =
  /(["']?)\b(password|passwd|pwd|pass|secret|secretAccessKey|secret_access_key|token|access_token|api[_-]?key|apikey|accessKeyId|access_key_id|auth|authorization|pin|cookie|user[_-]?key|app[_-]?token|chat[_-]?id)\1(\s*[:=]\s*)(["']?)([^"'\s&,;{}[\]]+)/gi;
const APP_TOKEN_RE = /\brh_[a-z]+_[A-Za-z0-9_-]+/g;
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
/** Long random-looking strings (upper and lower case and digits), as API keys and bot tokens are. */
const LONG_TOKEN_RE = /(?<![A-Za-z0-9_+=-])(?=[A-Za-z0-9_+=-]*[A-Z])(?=[A-Za-z0-9_+=-]*[a-z])(?=[A-Za-z0-9_+=-]*\d)[A-Za-z0-9_+=-]{28,}/g;
const MAC_RE = /\b[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}\b/g;
const BLUEZ_PATH_RE = /dev_[0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5}/g;
/** Pill ids are the Bluetooth address without the colons. */
const DEVICE_ID_RE = /\b[0-9a-fA-F]{12}\b/g;
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const IPV6_FULL_RE = /(?<![0-9A-Za-z:])(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?![0-9A-Za-z:])/g;
const IPV6_SHORT_RE =
  /(?<![0-9A-Za-z:])(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?(?:%[\w.-]+)?(?![0-9A-Za-z:])/g;
const HOME_RE = /(\/home\/|\/Users\/|\\Users\\)[^/\\\s"']+/gi;
/** The host in network errors such as "getaddrinfo ENOTFOUND my-server.example". */
const NET_ERROR_HOST_RE =
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|getaddrinfo)\s+([A-Za-z0-9][\w.-]*\.[A-Za-z][\w-]*)/g;
/** Names only meaningful on someone's own network or tailnet (rapthooker.local is everyone's default, so it stays). */
const PRIVATE_NAME_RE =
  /\b(?![Rr]apthooker\.local\b)[A-Za-z0-9][\w-]*(?:\.[\w-]+)*\.(?:local|lan|home|internal|home\.arpa|ts\.net|duckdns\.org)\b/g;

function urlHost(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '0.0.0.0', '[::]', '[::1]'].includes(host)) return u.host;
    if (PUBLIC_HOSTS.has(host)) return host;
    const suffix = PUBLIC_SUFFIXES.find((s) => host === s || host.endsWith(`.${s}`));
    if (suffix) return host === suffix ? host : `*.${suffix}`;
  } catch {
    // Not parseable: hide it all.
  }
  return '<host>';
}

function ipv4Label(ip: string): string {
  if (ip === '127.0.0.1' || ip === '0.0.0.0') return ip;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return '<lan-ip>';
  if (a === 100 && b >= 64 && b <= 127) return '<cgnat-ip>';
  if (a === 169 && b === 254) return '<link-local-ip>';
  return '<ip>';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Replacement {
  /** Text to find (case-insensitive, whole words). */
  find: string;
  /** What it becomes, e.g. "pill 1". */
  label: string;
}

export type Scrubber = (text: string) => string;

/** A scrubber that also swaps the given names and ids for neutral labels, and hides the hostname unless it's the default. */
export function makeScrubber(replacements: Replacement[] = [], hostname = ''): Scrubber {
  const known = replacements
    .filter((r) => r.find.trim().length >= 3)
    .sort((a, b) => b.find.length - a.find.length)
    .map((r) => ({ re: new RegExp(`(?<![\\w])${escapeRe(r.find.trim())}(?![\\w])`, 'gi'), label: r.label }));
  const host = hostname.split('.')[0]?.trim() ?? '';
  const hostRe = host.length >= 3 && !/^(rapthooker|localhost)$/i.test(host) ? new RegExp(`\\b${escapeRe(host)}\\b`, 'gi') : null;

  return (input: string): string => {
    let text = input;
    for (const k of known) text = text.replace(k.re, k.label);
    text = text
      .replace(URL_RE, (m, scheme: string) => {
        const rest = m.slice(scheme.length + 3);
        const more = /[/?#]./.test(rest);
        return `${scheme.toLowerCase()}://${urlHost(m)}${more ? '/...' : ''}`;
      })
      .replace(EMAIL_RE, '<email>')
      .replace(NET_ERROR_HOST_RE, (m, code: string, host: string) => (PUBLIC_HOSTS.has(host.toLowerCase()) ? m : `${code} <host>`))
      .replace(PRIVATE_NAME_RE, '<host>')
      .replace(AUTH_RE, (_m, kind: string) => `${kind} ${REDACTED}`)
      .replace(SECRET_KEY_RE, (_m, q: string, key: string, sep: string, q2: string) => `${q}${key}${q}${sep}${q2}${REDACTED}`)
      .replace(APP_TOKEN_RE, `rh_${REDACTED}`)
      .replace(AWS_KEY_RE, REDACTED)
      .replace(LONG_TOKEN_RE, REDACTED)
      .replace(BLUEZ_PATH_RE, 'dev_XX_XX_XX_XX_XX_XX')
      .replace(MAC_RE, (_m, sep: string) => ['XX', 'XX', 'XX', 'XX', 'XX', 'XX'].join(sep))
      .replace(DEVICE_ID_RE, '<device>')
      .replace(IPV4_RE, ipv4Label)
      .replace(IPV6_FULL_RE, '<ipv6>')
      .replace(IPV6_SHORT_RE, (m) => (m === '::' || m === '::1' || m.length < 3 ? m : '<ipv6>'))
      .replace(HOME_RE, (_m, prefix: string) => `${prefix}<user>`);
    if (hostRe) text = text.replace(hostRe, '<hostname>');
    return text;
  };
}
