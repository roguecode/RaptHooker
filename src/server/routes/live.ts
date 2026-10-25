import type { WebSocket } from 'ws';
import type { LiveMessage, Pill } from '@rapthooker/shared';
import { maskStatus } from '../webhooks.js';
import type { Broadcast, RouteContext } from './context.js';

/** Open sockets, each with whether it belongs to the owner. */
export type LiveSockets = Map<WebSocket, boolean>;

// Viewers get webhook statuses without error details (they can quote URLs and keys).
export function broadcaster(sockets: LiveSockets): Broadcast {
  return (msg, forViewers = msg) => {
    const data = JSON.stringify(msg);
    const viewerData = forViewers === msg ? data : JSON.stringify(forViewers);
    for (const [ws, owner] of sockets) if (ws.readyState === ws.OPEN) ws.send(owner ? data : viewerData);
  };
}

export function liveRoutes({ app, s, isOwner, broadcast }: RouteContext, sockets: LiveSockets): void {
  const { pills, brews, webhooks, alerts } = s;

  app.get('/api/live', { websocket: true }, (socket, req) => {
    sockets.set(socket, isOwner(req));
    socket.send(
      JSON.stringify({
        type: 'hello',
        pills: pills.list(),
        nearby: pills.nearby(),
        ble: s.scanner.status,
        clockSynced: s.clock.trusted,
        hub: s.settings.hub(),
      } satisfies LiveMessage),
    );
    const forget = () => sockets.delete(socket);
    socket.on('close', forget);
    socket.on('error', forget);
  });

  // A pill sends a burst of identical adverts: send its card at most every 1.5 s.
  const pending = new Map<string, NodeJS.Timeout>();
  const throttled = (key: string, ms: number, fn: () => void) => {
    if (pending.has(key)) return;
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        fn();
      }, ms),
    );
  };
  pills.on('pill', (pill: Pill) =>
    throttled(`pill:${pill.id}`, 1500, () => {
      const fresh = pills.get(pill.id);
      if (fresh) broadcast({ type: 'pill', pill: fresh });
    }),
  );
  pills.on('reading', (pillId: string, reading) => broadcast({ type: 'reading', pillId, reading }));
  pills.on('removed', (pillId: string) => broadcast({ type: 'pill-removed', pillId }));
  pills.on('nearby', () => throttled('nearby', 2000, () => broadcast({ type: 'nearby', nearby: pills.nearby() })));
  brews.on('brew', (brew) => {
    broadcast({ type: 'brew', brew });
    throttled(`pill:${brew.pillId}`, 300, () => {
      const fresh = pills.get(brew.pillId);
      if (fresh) broadcast({ type: 'pill', pill: fresh });
    });
  });
  brews.on('removed', (brew) => {
    broadcast({ type: 'brew-removed', brewId: brew.id, pillId: brew.pillId });
    const fresh = pills.get(brew.pillId);
    if (fresh) broadcast({ type: 'pill', pill: fresh });
  });
  webhooks.on('status', (webhookId: string, status) =>
    broadcast({ type: 'webhook', webhookId, status }, { type: 'webhook', webhookId, status: maskStatus(status) }),
  );
  alerts.on('event', (event) => broadcast({ type: 'alert', event }));
  s.scanner.on('status', (ble) => broadcast({ type: 'ble', ble, clockSynced: s.clock.trusted }));
  s.clock.on('trusted', () => broadcast({ type: 'ble', ble: s.scanner.status, clockSynced: true }));
  s.settings.on('hub', (hub) => broadcast({ type: 'hub', hub }));
  s.updates.on('update', (update) => broadcast({ type: 'update', update }));
  const heartbeat = setInterval(() => broadcast({ type: 'ping', at: Date.now() }), 15_000);
  heartbeat.unref();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const t of pending.values()) clearTimeout(t);
    for (const ws of sockets.keys()) ws.close();
  });
}
