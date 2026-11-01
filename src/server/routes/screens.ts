import {
  screenAdoptSchema,
  screenManualDoneSchema,
  screenManualSchema,
  screenPatchSchema,
  screenSetupSchema,
  type ScreenDevice,
} from '@rapthooker/shared';
import { ScreenError } from '../screens/index.js';
import type { RouteContext } from './context.js';

/** The original firmware for a screen (a file from its maker): at most what the screen's update space holds. */
const RESTORE_LIMIT = 1024 * 1024;

/**
 * Screens: setting them up, changing what they show, updating their firmware. The list is read-only and open like
 * the rest of the read-only API; everything else is the owner's. A screen's own picture is in routes/screen.ts.
 */
export function screensRoutes({ app, s, owner, broadcast }: RouteContext): void {
  const { screens } = s;

  screens.on('screen', (screen: ScreenDevice) => broadcast({ type: 'screen', screen }));
  screens.on('removed', (screenId: string) => broadcast({ type: 'screen-removed', screenId }));
  // Like the routes they come from, these two are the owner's.
  screens.on('setup', (setup) => broadcast({ type: 'screen-setup', setup }, null));
  screens.on('found', (found) => broadcast({ type: 'screens-found', found }, null));

  const one = (req: { params: unknown }): string => {
    const { id } = req.params as { id: string };
    if (!screens.get(id)) throw new ScreenError('Unknown screen', 404);
    return id;
  };

  app.get('/api/screens', async () => screens.list());

  app.get('/api/screens/wifi', owner, async () => screens.wifiStatus());
  app.post('/api/screens/wifi/scan', owner, async () => screens.scan());

  app.get('/api/screens/setup', owner, async () => screens.setupProgress());
  app.post('/api/screens/setup', owner, async (req, reply) => {
    const progress = screens.startSetup(screenSetupSchema.parse(req.body));
    return reply.code(202).send(progress);
  });

  app.get('/api/screens/found', owner, async () => screens.found());
  app.post('/api/screens/discover', owner, async () => screens.discover());
  app.post('/api/screens/adopt', owner, async (req) => {
    const { id, code, name, look } = screenAdoptSchema.parse(req.body);
    return screens.adopt(id, code, name, look);
  });

  // Set-up from the browser, for hubs that can't switch Wi-Fi themselves.
  app.post('/api/screens/manual', owner, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return screens.manualStart(screenManualSchema.parse(req.body));
  });
  app.post('/api/screens/manual/done', owner, async (req) => screens.manualDone(screenManualDoneSchema.parse(req.body)));
  app.get('/api/screens/firmware/:model', owner, async (req, reply) => {
    const { model } = req.params as { model: string };
    const fw = screens.firmwareImage(model.replace(/\.bin$/, ''));
    if (!fw) throw new ScreenError('No firmware for that screen', 404);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="SDP-rapthooker-screen-${fw.model}-${fw.version}.bin"`)
      .header('X-Firmware-Version', fw.version)
      .header('X-Firmware-Md5', fw.md5)
      .send(fw.data);
  });

  app.post('/api/screens/update-all', owner, async () => screens.updateAll());

  app.get('/api/screens/:id', async (req) => screens.get(one(req)));
  app.patch('/api/screens/:id', owner, async (req) => screens.patch(one(req), screenPatchSchema.parse(req.body)));
  app.delete('/api/screens/:id', owner, async (req, reply) => {
    const { reset } = req.query as { reset?: string };
    await screens.remove(one(req), reset === '1' || reset === 'true');
    return reply.code(204).send();
  });
  for (const what of ['identify', 'refresh', 'reboot'] as const) {
    app.post(`/api/screens/:id/${what}`, owner, async (req) => {
      await screens.action(one(req), what);
      return { ok: true };
    });
  }
  app.post('/api/screens/:id/update', owner, async (req) => screens.updateFirmware(one(req)));
  app.get('/api/screens/:id/log', owner, async (req, reply) => {
    const text = await screens.log(one(req));
    return reply.header('Content-Type', 'text/plain; charset=utf-8').header('Cache-Control', 'no-store').send(text);
  });

  // The original firmware comes in as raw bytes, so this route has its own body parser and size limit.
  void app.register(async (sub) => {
    sub.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: RESTORE_LIMIT }, (_req, body, done) =>
      done(null, body),
    );
    sub.post('/api/screens/:id/restore', { ...owner, bodyLimit: RESTORE_LIMIT }, async (req, reply) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ScreenError('Send the firmware file');
      await screens.restoreStock(one(req), req.body);
      return reply.code(204).send();
    });
  });
}
