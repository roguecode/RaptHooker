import { z } from 'zod';
import { channelInputSchema } from '@rapthooker/shared';
import type { RouteContext } from './context.js';

const channelTestSchema = z.object({ channel: channelInputSchema, id: z.string().max(64).nullable().default(null) });

/** Notification channels for alerts (ntfy, Pushover, Telegram, Discord, email). */
export function channelRoutes({ app, s, isOwner, owner }: RouteContext): void {
  const { channels, alerts } = s;

  // Viewers see the channels and how they're doing, but not the keys, topics or addresses.
  app.get('/api/channels', async (req) => channels.list(isOwner(req)));

  app.post('/api/channels', owner, async (req) => channels.create(channelInputSchema.parse(req.body)));

  app.put('/api/channels/:id', owner, async (req) => {
    const { id } = req.params as { id: string };
    return channels.update(id, channelInputSchema.parse(req.body));
  });

  app.delete('/api/channels/:id', owner, async (req, reply) => {
    const { id } = req.params as { id: string };
    channels.delete(id);
    alerts.forgetChannel(id);
    return reply.code(204).send();
  });

  app.post('/api/channels/test', owner, async (req) => {
    const { channel, id } = channelTestSchema.parse(req.body);
    await channels.test(channel, id, s.settings.hub().name);
    return { ok: true };
  });
}
