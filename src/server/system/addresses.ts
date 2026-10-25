import type { NetworkInterfaceInfo } from 'node:os';
import type { HubAddress } from '@rapthooker/shared';

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Virtual interfaces that other devices on the LAN can't reach the hub through. */
const VIRTUAL = /^(lo|tailscale|docker|veth|br-|virbr|vmnet|vboxnet|zt|wg|tun|utun|cni|flannel)/i;
/** Tailscale's own IPv6 range: only reachable on the tailnet, and the https name is better there. */
const TAILSCALE_V6 = /^fd7a:115c:a1e0:/i;

const isV4 = (a: NetworkInterfaceInfo) => a.family === 'IPv4' || (a.family as unknown) === 4;
const isV6 = (a: NetworkInterfaceInfo) => a.family === 'IPv6' || (a.family as unknown) === 6;
/** Global unicast (2000::/3) or unique local (fc00::/7). */
const routableV6 = (address: string) => /^[23]/.test(address) || /^f[cd]/i.test(address);

export interface AddressInputs {
  interfaces: Interfaces;
  hostname: string;
  port: number;
  /** Tailscale https URL (from `tailscale serve`), or null. */
  tailscaleUrl: string | null;
}

/** Ways to reach the hub: its LAN IP addresses (IPv4, or IPv6 when there's no IPv4), its .local name, its Tailscale name. */
export function listAddresses({ interfaces, hostname, port, tailscaleUrl }: AddressInputs): HubAddress[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (!list || VIRTUAL.test(name)) continue;
    for (const a of list) {
      if (a.internal) continue;
      if (isV4(a) && !a.address.startsWith('169.254.')) v4.push(a.address);
      else if (isV6(a) && routableV6(a.address) && !TAILSCALE_V6.test(a.address)) v6.push(a.address.split('%')[0]!);
    }
  }
  const suffix = port === 80 ? '' : `:${port}`;
  const lan = v4.length ? v4 : v6.map((a) => `[${a}]`);
  const out: HubAddress[] = [...new Set(lan)].map((host) => ({ kind: 'lan', url: `http://${host}${suffix}` }));
  const label = hostname.split('.')[0]?.trim().toLowerCase() ?? '';
  if (label && label !== 'localhost' && /^[a-z0-9-]+$/.test(label)) out.push({ kind: 'mdns', url: `http://${label}.local${suffix}` });
  if (tailscaleUrl) out.push({ kind: 'tailscale', url: tailscaleUrl });
  return out;
}

/** The machine's Tailscale name from `tailscale status --json`, or null when Tailscale isn't up. */
export function tailscaleDnsName(statusJson: string): string | null {
  try {
    const o = JSON.parse(statusJson) as { BackendState?: string; Self?: { DNSName?: string } };
    if (o.BackendState && o.BackendState !== 'Running') return null;
    const dns = o.Self?.DNSName?.trim().replace(/\.$/, '');
    return dns && /^[a-z0-9.-]+$/i.test(dns) ? dns.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The https URL `tailscale serve` gives this machine, from `tailscale serve status --json`. Null when serve is known to
 * be off, undefined when its status couldn't be read (then the plain https name is the best guess).
 */
export function tailscaleServeUrl(serveJson: string | null, dnsName: string): string | null | undefined {
  if (serveJson === null) return undefined;
  try {
    const o = JSON.parse(serveJson) as { Web?: Record<string, unknown> };
    const hosts = Object.keys(o.Web ?? {});
    if (!hosts.length) return null;
    const mine = hosts.find((h) => h.toLowerCase().startsWith(`${dnsName}:`)) ?? hosts[0]!;
    const port = mine.slice(mine.lastIndexOf(':') + 1);
    return port === '443' || !/^\d+$/.test(port) ? `https://${dnsName}` : `https://${dnsName}:${port}`;
  } catch {
    return undefined;
  }
}
