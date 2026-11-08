import {
  applyProfileSchema,
  BROWSER_PUSH,
  brewAlertInputSchema,
  brewCompareQuerySchema,
  brewEventInputSchema,
  brewListQuerySchema,
  brewPatchSchema,
  endBrewSchema,
  startBrewSchema,
  type BrewAlertInput,
} from '@rapthooker/shared';
import { PillError } from '../pills.js';
import { BrewError } from '../brews.js';
import { ProfileError } from '../profiles.js';
import { sendCsv } from './csv.js';
import type { RouteContext } from './context.js';

export function brewRoutes({ app, s, owner }: RouteContext): void {
  const { store, pills, brews, alerts, channels } = s;
  const profiles = s.profiles!;

  /** A brew's alert as sent, without channels that don't exist (any more). */
  const parseAlert = (body: unknown): BrewAlertInput => {
    const input = brewAlertInputSchema.parse(body);
    if (input.channelIds === 'all') return input;
    return { ...input, channelIds: [...new Set(input.channelIds)].filter((id) => id === BROWSER_PUSH || channels.get(id) !== null) };
  };

  app.get('/api/brews', async (req) => {
    const { pill } = brewListQuerySchema.parse(req.query);
    return brews.list(pill);
  });

  // Gravity and temperature curves of a few brews by time since each started, for overlaying them.
  app.get('/api/brews/compare', async (req) => {
    const { ids } = brewCompareQuerySchema.parse(req.query);
    return brews.curves(ids);
  });

  app.get('/api/brews/:id', async (req) => {
    const { id } = req.params as { id: string };
    const brew = brews.get(id);
    if (!brew) throw new BrewError('Unknown brew', 404);
    return brew;
  });

  app.post('/api/brews', owner, async (req) => {
    const body = startBrewSchema.parse(req.body);
    const { pillId, startedAt, profileId, ...input } = body;
    // Checked first, so a brew isn't started without the profile it was meant to have.
    if (profileId !== undefined && !profiles.get(profileId)) throw new ProfileError('Unknown profile', 404);
    const brew = brews.start(pillId, input, startedAt);
    return profileId === undefined ? brew : profiles.apply(profileId, brew.id);
  });

  app.patch('/api/brews/:id', owner, async (req) => {
    const { id } = req.params as { id: string };
    const body = brewPatchSchema.parse(req.body);
    return brews.update(id, body);
  });

  app.post('/api/brews/:id/end', owner, async (req) => {
    const { id } = req.params as { id: string };
    const { endedAt } = endBrewSchema.parse(req.body ?? {});
    return brews.end(id, endedAt);
  });

  app.delete('/api/brews/:id', owner, async (req, reply) => {
    const { id } = req.params as { id: string };
    brews.delete(id);
    return reply.code(204).send();
  });
  // Its own alerts went with it (Store.deleteBrew).
  brews.on('removed', (brew: { id: string }) => alerts.forgetBrew(brew.id));

  // Events: dry hops, temperature changes, cold crashes, additions and notes along a brew. Changes go out live with the brew.

  app.get('/api/brews/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    if (!brews.get(id)) throw new BrewError('Unknown brew', 404);
    return brews.events(id);
  });

  app.post('/api/brews/:id/events', owner, async (req) => {
    const { id } = req.params as { id: string };
    return brews.addEvent(id, brewEventInputSchema.parse(req.body));
  });

  app.put('/api/brews/:id/events/:eventId', owner, async (req) => {
    const { id, eventId } = req.params as { id: string; eventId: string };
    return brews.updateEvent(id, eventId, brewEventInputSchema.parse(req.body));
  });

  app.delete('/api/brews/:id/events/:eventId', owner, async (req, reply) => {
    const { id, eventId } = req.params as { id: string; eventId: string };
    brews.deleteEvent(id, eventId);
    return reply.code(204).send();
  });

  // A brew's own alerts: watching its pill while it runs, and going with it.

  app.get('/api/brews/:id/alerts', async (req) => {
    const { id } = req.params as { id: string };
    if (!brews.get(id)) throw new BrewError('Unknown brew', 404);
    return alerts.listBrewAlerts(id);
  });

  app.post('/api/brews/:id/alerts', owner, async (req) => {
    const { id } = req.params as { id: string };
    if (!brews.get(id)) throw new BrewError('Unknown brew', 404);
    return alerts.createBrewAlert(id, parseAlert(req.body));
  });

  app.put('/api/brews/:id/alerts/:alertId', owner, async (req) => {
    const { id, alertId } = req.params as { id: string; alertId: string };
    return alerts.updateBrewAlert(id, alertId, parseAlert(req.body));
  });

  app.delete('/api/brews/:id/alerts/:alertId', owner, async (req, reply) => {
    const { id, alertId } = req.params as { id: string; alertId: string };
    alerts.deleteBrewAlert(id, alertId);
    return reply.code(204).send();
  });

  // Adds a profile's alerts and planned events to a running brew.
  app.post('/api/brews/:id/profile', owner, async (req) => {
    const { id } = req.params as { id: string };
    const { profileId } = applyProfileSchema.parse(req.body);
    return profiles.apply(profileId, id);
  });

  app.get('/api/brews/:id/export.csv', async (req, reply) => {
    const { id } = req.params as { id: string };
    const brew = brews.get(id);
    if (!brew) throw new BrewError('Unknown brew', 404);
    const pill = pills.get(brew.pillId);
    if (!pill) throw new PillError('That pill has been removed', 404);
    return sendCsv(store, reply, pill, brew.startedAt, brew.endedAt ?? Date.now(), `${brew.name}.csv`);
  });
}
