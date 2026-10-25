import type { UpdateInfo } from '@rapthooker/shared';
import type { RouteContext } from './context.js';

/** Release check and self-update. */
export function updateRoutes({ app, s, owner }: RouteContext): void {
  app.get('/api/update', async (): Promise<UpdateInfo> => s.updates.info());

  app.post('/api/update/check', owner, async (): Promise<UpdateInfo> => s.updates.checkNow());

  app.post('/api/update/apply', owner, async (): Promise<UpdateInfo> => s.updates.apply());

  app.post('/api/update/switch', owner, async (): Promise<UpdateInfo> => s.updates.switchToRelease());
}
