import { kegEndSchema, kegPatchSchema, kegStartSchema } from '@rapthooker/shared';
import { z } from 'zod';
import { KegError } from '../kegs.js';
import type { RouteContext } from './context.js';

/** Beers kegged up under RAPT Laser Levels. Anyone can see them; the owner kegs up, changes and empties them. */
export function kegRoutes({ app, s, owner, broadcast }: RouteContext): void {
  const kegs = s.kegs!;
  const { pills } = s;

  app.get('/api/kegs', async (req) => {
    const { pill } = z.object({ pill: z.string().min(1).max(64).optional() }).parse(req.query);
    return kegs.list(pill);
  });

  app.get('/api/kegs/:id', async (req) => {
    const keg = kegs.get((req.params as { id: string }).id);
    if (!keg) throw new KegError('Unknown keg', 404);
    return keg;
  });

  app.post('/api/kegs', owner, async (req) => {
    const { pillId, ...input } = kegStartSchema.parse(req.body);
    return kegs.start(pillId, input);
  });

  app.patch('/api/kegs/:id', owner, async (req) => kegs.update((req.params as { id: string }).id, kegPatchSchema.parse(req.body)));

  app.post('/api/kegs/:id/end', owner, async (req) => kegs.end((req.params as { id: string }).id, kegEndSchema.parse(req.body ?? {}).at));

  app.delete('/api/kegs/:id', owner, async (req, reply) => {
    kegs.delete((req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // The device's card shows its keg, so it's sent again too.
  const refresh = (pillId: string) => {
    const fresh = pills.get(pillId);
    if (fresh) broadcast({ type: 'pill', pill: fresh });
  };
  kegs.on('keg', (keg) => {
    broadcast({ type: 'keg', keg });
    refresh(keg.pillId);
  });
  kegs.on('removed', (keg) => {
    broadcast({ type: 'keg-removed', kegId: keg.id, pillId: keg.pillId });
    refresh(keg.pillId);
  });
}
