import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { RouteContext } from './context.js';

/** Serves the built web app, falling back to index.html for anything that isn't the API. */
export async function webRoutes({ app, s }: RouteContext): Promise<void> {
  const { config } = s;
  if (existsSync(join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      setHeaders: (res, path) => {
        if (/(sw\.js|index\.html|manifest\.webmanifest)$/.test(path)) res.header('Cache-Control', 'no-cache');
        else if (/[\\/]assets[\\/]/.test(path)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  } else {
    app.log.warn({ webDir: config.webDir }, 'the web app is not built; only the API is served');
    app.get('/', async (_req, reply) =>
      reply.type('text/plain').send('RaptHooker is running. Build the web app (npm run build) or use the Vite dev server.'),
    );
  }
}
