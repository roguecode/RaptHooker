import { tokenInputSchema, type ApiTokenCreated } from '@rapthooker/shared';
import type { RouteContext } from './context.js';

/** API tokens: 'read' for scripts using the read-only API, 'relay' for Bluetooth relays posting adverts. Owner only. */
export function tokenRoutes({ app, s, owner }: RouteContext): void {
  const { tokens } = s;

  app.get('/api/tokens', owner, async () => tokens.list());

  // The token itself is only ever in this response; the hub keeps a hash.
  app.post('/api/tokens', owner, async (req, reply): Promise<ApiTokenCreated> => {
    const { name, scope } = tokenInputSchema.parse(req.body);
    reply.header('Cache-Control', 'no-store');
    return tokens.create(name, scope);
  });

  app.delete('/api/tokens/:id', owner, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!tokens.remove(id)) return reply.code(404).send({ error: 'Unknown token' });
    return reply.code(204).send();
  });
}
