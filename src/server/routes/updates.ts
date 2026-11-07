import { z } from 'zod';
import type { UpdateInfo } from '@rapthooker/shared';
import type { RouteContext } from './context.js';

const installSchema = z.object({ version: z.string().trim().min(1).max(64) });

/** Release check and self-update, and trying a beta (and going back from one). */
export function updateRoutes({ app, s, owner }: RouteContext): void {
  app.get('/api/update', async (): Promise<UpdateInfo> => s.updates.info());

  app.post('/api/update/check', owner, async (): Promise<UpdateInfo> => s.updates.checkNow());

  app.post('/api/update/apply', owner, async (): Promise<UpdateInfo> => s.updates.apply());

  app.post('/api/update/switch', owner, async (): Promise<UpdateInfo> => s.updates.switchToRelease());

  app.post('/api/update/betas', owner, async (): Promise<UpdateInfo> => s.updates.checkBetasNow());

  app.post('/api/update/install', owner, async (req): Promise<UpdateInfo> => s.updates.install(installSchema.parse(req.body).version));
}
