import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import mdns from 'multicast-dns';
import type { FoundScreen } from '@rapthooker/shared';
import type { Logger } from '../log.js';

const SERVICE = '_rhscreen._tcp.local';
const VIRTUAL = /^(lo|tailscale|docker|veth|br-|virbr|vmnet|vboxnet|zt|wg|tun|utun|cni|flannel|vEthernet)/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The hub's LAN IPv4 addresses (a screen's hotspot, 192.168.4.x, isn't one). */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list ?? []) {
      if (!a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.') && !a.address.startsWith('192.168.4.'))
        out.push(a.address);
    }
  }
  return out;
}

interface Instance {
  host?: string;
  port?: number;
  txt?: Record<string, string>;
}

/**
 * RaptHooker screens on the network, from mDNS (they advertise _rhscreen._tcp with their id, model, firmware and
 * whether they're claimed). Asks on every LAN interface: one socket for all of them asks on just one.
 */
export async function browseScreens(log: Logger, ms = 3000): Promise<FoundScreen[]> {
  const instances = new Map<string, Instance>();
  const addresses = new Map<string, string>();
  const sockets: ReturnType<typeof mdns>[] = [];
  const onResponse = (res: mdns.ResponsePacket) => {
    for (const a of [...(res.answers ?? []), ...(res.additionals ?? [])]) {
      if (a.type === 'PTR' && a.name === SERVICE) {
        if (!instances.has(String(a.data))) instances.set(String(a.data), {});
      } else if (a.type === 'SRV' && a.name.endsWith(`.${SERVICE}`)) {
        instances.set(a.name, { ...instances.get(a.name), host: a.data.target, port: a.data.port });
      } else if (a.type === 'TXT' && a.name.endsWith(`.${SERVICE}`)) {
        const list = (Array.isArray(a.data) ? a.data : [a.data]) as (Buffer | string)[];
        const txt = Object.fromEntries(
          list.map((b) => String(b)).flatMap((s) => (s.includes('=') ? [[s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]] : [])),
        );
        instances.set(a.name, { ...instances.get(a.name), txt });
      } else if (a.type === 'A') {
        addresses.set(a.name, String(a.data));
      }
    }
  };
  for (const address of lanAddresses()) {
    try {
      const m = mdns({ interface: address, reuseAddr: true });
      m.on('response', onResponse);
      m.on('error', (err: Error) => log.debug({ err: err.message, address }, 'mDNS'));
      sockets.push(m);
    } catch (err) {
      log.debug({ err: (err as Error).message, address }, "can't use mDNS here");
    }
  }
  const ask = () => sockets.forEach((m) => m.query({ questions: [{ name: SERVICE, type: 'PTR' }] }));
  ask();
  await sleep(Math.min(1000, ms / 2));
  ask();
  await sleep(ms - Math.min(1000, ms / 2));
  for (const m of sockets) m.destroy();
  const out: FoundScreen[] = [];
  for (const i of instances.values()) {
    const ip = i.host ? addresses.get(i.host) : undefined;
    if (!i.txt?.id || !/^[0-9a-f]{12}$/.test(i.txt.id) || !ip) continue;
    out.push({
      id: i.txt.id,
      model: i.txt.model ?? '',
      firmware: i.txt.fw ?? '',
      api: Number(i.txt.api ?? 1),
      ip: i.port && i.port !== 80 ? `${ip}:${i.port}` : ip,
      hostname: (i.host ?? '').replace(/\.local$/, ''),
      claimed: i.txt.claimed === '1',
    });
  }
  return out;
}

/** A screen's IPv4 address from its mDNS name (rh-screen-1c1802), through the system's resolver; null if not found. */
export async function resolveScreen(hostname: string): Promise<string | null> {
  try {
    return (await lookup(`${hostname}.local`, { family: 4 })).address;
  } catch {
    return null;
  }
}
