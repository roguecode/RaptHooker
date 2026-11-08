import { brewProfileInputSchema } from '@rapthooker/shared';
import { ProfileError } from '../profiles.js';
import type { RouteContext } from './context.js';

/** Brew profiles: alerts and planned events a brew can start with. */
export function profileRoutes({ app, s, owner }: RouteContext): void {
  const profiles = s.profiles!;

  app.get('/api/brew-profiles', async () => profiles.list());

  app.get('/api/brew-profiles/:id', async (req) => {
    const { id } = req.params as { id: string };
    const profile = profiles.get(id);
    if (!profile) throw new ProfileError('Unknown profile', 404);
    return profile;
  });

  app.post('/api/brew-profiles', owner, async (req) => profiles.create(brewProfileInputSchema.parse(req.body)));

  app.put('/api/brew-profiles/:id', owner, async (req) => {
    const { id } = req.params as { id: string };
    return profiles.update(id, brewProfileInputSchema.parse(req.body));
  });

  app.delete('/api/brew-profiles/:id', owner, async (req, reply) => {
    const { id } = req.params as { id: string };
    profiles.delete(id);
    return reply.code(204).send();
  });
}
