import {
  buildBatchContext,
  buildContext,
  deliveriesQuerySchema,
  renderBatchRequest,
  renderRequest,
  sampleReading,
  webhookEnabledSchema,
  webhookImportSchema,
  webhookInputSchema,
  webhookPauseSchema,
  webhookTestSchema,
  type WebhookInput,
} from '@rapthooker/shared';
import { maskWebhook, WebhookError } from '../webhooks.js';
import type { RouteContext } from './context.js';

/** Problems that stop a webhook being switched on: no proper URL, unfilled <PLACEHOLDERS> or a body that isn't JSON. */
function webhookProblems(input: WebhookInput): string[] {
  const now = Date.now();
  const intervalSec = Math.round(input.intervalMin * 60);
  const ctx = buildContext({
    pill: {
      id: 'sample',
      name: 'Sample Pill',
      address: '00:00:00:00:00:02',
      raptId: '00:00:00:00:00:00',
      info: { firmware: null, deviceType: null, payloadVersion: 2 },
    },
    reading: sampleReading(now),
    brew: null,
    gravityUnit: input.gravityUnit,
    temperatureUnit: input.temperatureUnit,
    intervalSec,
    now,
    appVersion: '0',
  });
  const rendered = input.batch
    ? renderBatchRequest(input, [ctx, ctx], buildBatchContext({ count: 2, now, intervalSec, appVersion: '0' }))
    : renderRequest(input, ctx);
  return rendered.warnings.filter((w) => !w.startsWith('Unknown variable'));
}

/** Imports can be big: up to 500 webhooks with long bodies. */
const IMPORT_LIMIT = 16 * 1024 * 1024;

export function webhookRoutes({ app, s, isOwner, owner }: RouteContext): void {
  const { webhooks } = s;
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get('/api/webhooks', async (req) => {
    const list = webhooks.list();
    return isOwner(req) ? list : list.map(maskWebhook);
  });

  const checkEnabled = (input: WebhookInput) => {
    if (!input.enabled) return;
    const problems = webhookProblems(input);
    if (problems.length) throw new WebhookError(`${problems.join('. ')}. (Or save it switched off for now.)`);
  };

  app.post('/api/webhooks', owner, async (req) => {
    const input = webhookInputSchema.parse(req.body) as WebhookInput;
    checkEnabled(input);
    return webhooks.create(input);
  });

  // The export holds API keys, so it's for the owner only and never cached.
  app.get('/api/webhooks/export', owner, async (_req, reply) => {
    const data = webhooks.exportAll();
    const date = new Date(data.exportedAt).toISOString().slice(0, 10);
    return reply
      .header('Content-Disposition', `attachment; filename="rapthooker-webhooks-${date}.json"`)
      .header('Cache-Control', 'no-store')
      .send(data);
  });

  // New webhooks from an export, switched off until you've checked them.
  app.post('/api/webhooks/import', { ...owner, bodyLimit: IMPORT_LIMIT }, async (req) => {
    const data = webhookImportSchema.parse(req.body);
    return webhooks.importAll(data.webhooks as WebhookInput[]);
  });

  app.put('/api/webhooks/:id', owner, async (req) => {
    const input = webhookInputSchema.parse(req.body) as WebhookInput;
    checkEnabled(input);
    return webhooks.update(idOf(req), input);
  });

  app.post('/api/webhooks/:id/enabled', owner, async (req) => {
    const id = idOf(req);
    const { enabled } = webhookEnabledSchema.parse(req.body);
    const hook = webhooks.get(id);
    if (!hook) throw new WebhookError('Unknown webhook', 404);
    if (enabled) checkEnabled({ ...hook, enabled });
    return webhooks.setEnabled(id, enabled);
  });

  app.post('/api/webhooks/:id/pause', owner, async (req) => {
    const { until } = webhookPauseSchema.parse(req.body);
    return webhooks.pause(idOf(req), until);
  });

  app.post('/api/webhooks/:id/duplicate', owner, async (req) => webhooks.duplicate(idOf(req)));

  app.delete('/api/webhooks/:id', owner, async (req, reply) => {
    webhooks.delete(idOf(req));
    return reply.code(204).send();
  });

  app.get('/api/webhooks/:id/deliveries', owner, async (req) => {
    const id = idOf(req);
    const { limit } = deliveriesQuerySchema.parse(req.query);
    if (!webhooks.get(id)) throw new WebhookError('Unknown webhook', 404);
    return webhooks.deliveries(id, limit);
  });

  app.post('/api/webhooks/test', owner, async (req) => {
    const body = webhookTestSchema.parse(req.body);
    return webhooks.test(body.webhook as WebhookInput, body.webhookId, body.pillId);
  });
}
