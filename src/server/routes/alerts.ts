import { alertEventsQuerySchema, alertInputSchema, BROWSER_PUSH, type AlertRuleInput } from '@rapthooker/shared';
import type { RouteContext } from './context.js';

export function alertRoutes({ app, s, owner }: RouteContext): void {
  const { alerts, channels } = s;

  /** The rule as sent, without channels that don't exist (any more). */
  const parse = (body: unknown): AlertRuleInput => {
    const input = alertInputSchema.parse(body);
    if (input.channelIds === 'all') return input;
    return { ...input, channelIds: [...new Set(input.channelIds)].filter((id) => id === BROWSER_PUSH || channels.get(id) !== null) };
  };

  app.get('/api/alerts/rules', async () => alerts.list());

  app.post('/api/alerts/rules', owner, async (req) => alerts.create(parse(req.body)));

  app.put('/api/alerts/rules/:id', owner, async (req) => {
    const { id } = req.params as { id: string };
    return alerts.update(id, parse(req.body));
  });

  app.delete('/api/alerts/rules/:id', owner, async (req, reply) => {
    const { id } = req.params as { id: string };
    alerts.delete(id);
    return reply.code(204).send();
  });

  app.get('/api/alerts/events', async (req) => {
    const { limit } = alertEventsQuerySchema.parse(req.query);
    return alerts.events(limit);
  });
}
