import { SCREEN_FORMATS, screenQuery, type ScreenFormat } from '@rapthooker/shared';
import { PillError } from '../pills.js';
import { ScreenService } from '../screen/index.js';
import type { RouteContext } from './context.js';

/**
 * Screen images: GET /api/image.png (every device) and /api/pills/:id/image.png (one), also .jpg and .bmp. Like the rest
 * of the read-only API they're open to anyone who can reach the hub, so a small screen can fetch them without signing in.
 * A RaptHooker screen fetches /api/screens/:id/image.jpg, drawn with the options saved for it.
 */
export function screenRoutes({ app, s }: RouteContext): void {
  const screens = new ScreenService({ store: s.store, pills: s.pills, settings: s.settings, config: s.config, alerts: s.alerts });

  const format = (raw: string): ScreenFormat => {
    const f = raw.toLowerCase() === 'jpeg' ? 'jpg' : raw.toLowerCase();
    if (!(SCREEN_FORMATS as readonly string[]).includes(f)) throw new PillError('Unknown image type: use .png, .jpg or .bmp', 404);
    return f as ScreenFormat;
  };

  app.get('/api/image.:format', async (req, reply) => {
    const params = req.params as { format: string };
    const image = await screens.image(null, format(params.format), req.query as Record<string, unknown>);
    return reply.code(image.status).header('Content-Type', image.type).header('Cache-Control', 'no-store').send(image.body);
  });

  app.get('/api/pills/:id/image.:format', async (req, reply) => {
    const params = req.params as { id: string; format: string };
    const image = await screens.image(params.id, format(params.format), req.query as Record<string, unknown>);
    return reply.code(image.status).header('Content-Type', image.type).header('Cache-Control', 'no-store').send(image.body);
  });

  // The screen says how it's doing in its request's headers; X-Refresh tells it when to come back.
  app.get('/api/screens/:id/image.jpg', async (req, reply) => {
    const { id } = req.params as { id: string };
    const picture = s.screens.pictureOf(id);
    if (!picture) return reply.code(404).send({ error: 'Unknown screen' });
    s.screens.seen(id, req.headers, req.ip);
    const query = Object.fromEntries(new URLSearchParams(screenQuery(picture.options, { allDevices: picture.pillId === null })));
    const image = await screens.image(picture.pillId, 'jpg', query);
    // A pill that's gone still gets a picture saying so, which the screen should show rather than call an error.
    return reply
      .code(200)
      .header('Content-Type', image.type)
      .header('Cache-Control', 'no-store')
      .header('X-Refresh', String(picture.interval))
      .send(image.body);
  });
}
