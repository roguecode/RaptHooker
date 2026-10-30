import {
  adoptPillSchema,
  chartExclusionSchema,
  csvExportQuerySchema,
  historyQuerySchema,
  nearbyIgnoreSchema,
  pillOrderSchema,
  pillPatchSchema,
} from '@rapthooker/shared';
import { PillError } from '../pills.js';
import { sendCsv } from './csv.js';
import type { RouteContext } from './context.js';

export function pillRoutes({ app, s, owner }: RouteContext): void {
  const { config, store, pills, brews } = s;

  app.get('/api/state', async () => ({ pills: pills.list(), nearby: pills.nearby(), ble: s.scanner.status, clockSynced: s.clock.trusted }));

  app.get('/api/pills', async () => pills.list());

  app.post('/api/pills', owner, async (req) => {
    const body = adoptPillSchema.parse(req.body);
    return pills.adopt(body.address, body);
  });

  app.patch('/api/pills/:id', owner, async (req) => {
    const { id } = req.params as { id: string };
    const body = pillPatchSchema.parse(req.body);
    if (body.archived === true) {
      const brew = brews.activeFor(id);
      if (brew) throw new PillError(`End the brew "${brew.name}" before archiving this pill`, 409);
    }
    return pills.update(id, body);
  });

  app.delete('/api/pills/:id', owner, async (req, reply) => {
    const { id } = req.params as { id: string };
    pills.remove(id);
    return reply.code(204).send();
  });

  app.post('/api/pills/order', owner, async (req, reply) => {
    pills.reorder(pillOrderSchema.parse(req.body).ids);
    return reply.code(204).send();
  });

  app.post('/api/pills/:id/exclusions', owner, async (req) => {
    const { id } = req.params as { id: string };
    return pills.addExclusion(id, chartExclusionSchema.parse(req.body));
  });

  app.delete('/api/pills/:id/exclusions/:exclusionId', owner, async (req) => {
    const { id, exclusionId } = req.params as { id: string; exclusionId: string };
    return pills.removeExclusion(id, exclusionId);
  });

  app.post('/api/nearby/ignore', owner, async (req) => {
    const body = nearbyIgnoreSchema.parse(req.body);
    pills.ignore(body.address, body.ignored);
    return { ignored: pills.ignoredAddresses() };
  });

  app.get('/api/pills/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    if (!pills.has(id)) throw new PillError('Unknown pill', 404);
    const q = historyQuerySchema.parse(req.query);
    if (q.to < q.from) throw new PillError('"to" must be after "from"');
    return store.history(id, q.from, q.to, {
      maxPoints: q.points,
      gapMs: pills.gapMs(id),
      offsets: pills.offsets(id),
      model: pills.model(id),
      rawFrom: config.rawRetentionDays > 0 ? Date.now() - config.rawRetentionDays * 86_400_000 : undefined,
      exclude: q.exclude === '1' ? pills.exclusions(id) : undefined,
    });
  });

  app.get('/api/pills/:id/export.csv', async (req, reply) => {
    const { id } = req.params as { id: string };
    const pill = pills.get(id);
    if (!pill) throw new PillError('Unknown pill', 404);
    const q = csvExportQuerySchema.parse(req.query);
    return sendCsv(store, reply, pill, q.from, q.to ?? Date.now(), `${pill.name}-readings.csv`);
  });
}
