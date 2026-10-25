import { pushUnsubscribeSchema } from '@rapthooker/shared';
import { isPushSubscription } from '../push.js';
import type { RouteContext } from './context.js';

export function pushRoutes({ app, s, sessionOf, owner }: RouteContext): void {
  const { push } = s;

  app.get('/api/push/key', async () => ({ publicKey: push.publicKey }));

  app.post('/api/push/subscribe', owner, async (req, reply) => {
    if (!isPushSubscription(req.body)) return reply.code(400).send({ error: 'Invalid push subscription' });
    push.subscribe(req.body, sessionOf(req).user);
    return reply.code(204).send();
  });

  app.post('/api/push/unsubscribe', async (req, reply) => {
    const { endpoint } = pushUnsubscribeSchema.parse(req.body);
    push.unsubscribe(endpoint);
    return reply.code(204).send();
  });

  app.post('/api/push/test', owner, async (_req, reply) => {
    await push.send({ title: 'RaptHooker', body: 'Notifications are working 🎉', tag: 'rapthooker-test', url: '/#/alerts' });
    return reply.code(204).send();
  });
}
