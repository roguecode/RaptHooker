import mdns from 'multicast-dns';
import { afterEach, describe, expect, it } from 'vitest';
import { browseScreens } from '../screens/discovery.js';
import { silent } from './helpers.js';

const SERVICE = '_rhscreen._tcp.local';
const INSTANCE = `rh-screen-1c1802.${SERVICE}`;

let responder: ReturnType<typeof mdns> | null = null;
afterEach(() => {
  responder?.destroy();
  responder = null;
});

// Real multicast on this machine, as a Pi hears a screen. Only on Linux (CI, a Pi): Windows hands multicast to sockets
// that macOS and Linux don't, and its own mDNS service may hold the port.
describe.runIf(process.platform === 'linux')('finding screens with mDNS', () => {
  it('hears a screen that answers to the whole network, as the screens do', async () => {
    responder = mdns({ reuseAddr: true });
    responder.on('query', (q) => {
      if (!q.questions.some((x) => x.name === SERVICE && x.type === 'PTR')) return;
      // No address to answer to: it goes to the mDNS group, like an ESP8266 screen's answer.
      responder!.respond({
        answers: [{ name: SERVICE, type: 'PTR', ttl: 120, data: INSTANCE }],
        additionals: [
          { name: INSTANCE, type: 'SRV', ttl: 120, data: { target: 'rh-screen-1c1802.local', port: 80 } },
          { name: INSTANCE, type: 'TXT', ttl: 120, data: ['id=f008d11c1802', 'model=sdpro-240', 'fw=1.1.2', 'api=1', 'claimed=1'] },
          { name: 'rh-screen-1c1802.local', type: 'A', ttl: 120, data: '192.168.50.9' },
        ],
      });
    });
    await new Promise<void>((resolve) => responder!.once('ready', () => resolve()));

    expect(await browseScreens(silent, 1500)).toContainEqual({
      id: 'f008d11c1802',
      model: 'sdpro-240',
      firmware: '1.1.2',
      api: 1,
      ip: '192.168.50.9',
      hostname: 'rh-screen-1c1802',
      claimed: true,
    });
  });
});
