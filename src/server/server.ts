import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import type { Session } from '@rapthooker/shared';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { PillError, type PillService } from './pills.js';
import { BrewError, type BrewService } from './brews.js';
import { WebhookError, type WebhookService } from './webhooks.js';
import { AlertError, type AlertService } from './alerts.js';
import type { PushService } from './push.js';
import type { Maintenance } from './maintenance.js';
import type { Scanner } from './ble/scanner.js';
import type { ClockGuard } from './clock.js';
import { Auth, crossSiteRequest, PinError } from './auth.js';
import type { Settings } from './settings.js';
import type { MqttService } from './mqtt.js';
import { ChannelError, type ChannelService } from './channels.js';
import type { UpdateService } from './updates.js';
import type { SystemService } from './system.js';
import type { TokenService } from './tokens.js';
import type { LogBuffer } from './logbuffer.js';
import type { RouteContext } from './routes/context.js';
import { sessionRoutes } from './routes/session.js';
import { pillRoutes } from './routes/pills.js';
import { brewRoutes } from './routes/brews.js';
import { webhookRoutes } from './routes/webhooks.js';
import { alertRoutes } from './routes/alerts.js';
import { pushRoutes } from './routes/push.js';
import { settingsRoutes } from './routes/settings.js';
import { broadcaster, liveRoutes, type LiveSockets } from './routes/live.js';
import { webRoutes } from './routes/web.js';
import { systemRoutes } from './routes/system.js';
import { backupRoutes } from './routes/backups.js';
import { mqttRoutes } from './routes/mqtt.js';
import { channelRoutes } from './routes/channels.js';
import { tokenRoutes } from './routes/tokens.js';
import { relayRoutes } from './routes/relay.js';
import { updateRoutes } from './routes/updates.js';

export { Settings, type NotificationUnits } from './settings.js';

export interface Services {
  config: Config;
  store: Store;
  pills: PillService;
  brews: BrewService;
  webhooks: WebhookService;
  alerts: AlertService;
  push: PushService;
  maintenance: Maintenance;
  scanner: Scanner;
  clock: ClockGuard;
  settings: Settings;
  mqtt: MqttService;
  channels: ChannelService;
  updates: UpdateService;
  system: SystemService;
  tokens: TokenService;
  logs: LogBuffer;
  version: string;
  startedAt: number;
}

function cookieSecret(dataDir: string): string {
  const file = join(dataDir, 'cookie-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export async function buildServer(s: Services, opts: { logger?: FastifyBaseLogger } = {}): Promise<FastifyInstance> {
  const { config, store } = s;
  const app = (opts.logger
    ? Fastify({ loggerInstance: opts.logger, logController: new LogController({ disableRequestLogging: true }) })
    : Fastify({ logger: false })) as unknown as FastifyInstance;
  const auth = new Auth(config.auth, store, s.tokens);

  await app.register(cookie, { secret: cookieSecret(config.dataDir) });
  await app.register(websocket);

  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req, reply) => {
    if (crossSiteRequest(req)) {
      return reply.code(403).send({ error: 'Changes can only be made from the RaptHooker app itself, not from another website.' });
    }
    (req as FastifyRequest & { session: Session }).session = auth.session(req);
  });
  const sessionOf = (req: FastifyRequest) => (req as FastifyRequest & { session: Session }).session;
  const isOwner = (req: FastifyRequest) => sessionOf(req).role === 'owner';
  const requireOwner = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isOwner(req)) return reply.code(403).send({ error: 'Only the owner can do that. Sign in with the PIN under Settings.' });
  };
  const owner = { preHandler: requireOwner };

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply
        .code(400)
        .send({ error: err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ') });
    }
    const known =
      err instanceof PillError ||
      err instanceof BrewError ||
      err instanceof WebhookError ||
      err instanceof AlertError ||
      err instanceof ChannelError ||
      err instanceof PinError;
    const status = known ? err.statusCode! : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: err.message });
  });

  const sockets: LiveSockets = new Map();
  const ctx: RouteContext = { app, s, auth, sessionOf, isOwner, owner, broadcast: broadcaster(sockets) };

  sessionRoutes(ctx);
  pillRoutes(ctx);
  brewRoutes(ctx);
  webhookRoutes(ctx);
  alertRoutes(ctx);
  pushRoutes(ctx);
  settingsRoutes(ctx);
  systemRoutes(ctx);
  backupRoutes(ctx);
  mqttRoutes(ctx);
  channelRoutes(ctx);
  tokenRoutes(ctx);
  relayRoutes(ctx);
  updateRoutes(ctx);
  liveRoutes(ctx, sockets);
  await webRoutes(ctx);

  return app;
}
