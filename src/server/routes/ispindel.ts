import { performance } from 'node:perf_hooks';
import { ISPINDEL_PATH, ispindelPostSchema, ispindelSetupSchema } from '@rapthooker/shared';
import { bearer } from '../tokens.js';
import type { RouteContext } from './context.js';

/** A token may post this many readings a minute (an iSpindel posts once every few minutes at most). */
const POSTS_PER_MINUTE = 120;

/**
 * iSpindels posting their readings (the iSpindel's "HTTP" service), and setting them up from the Add device dialog.
 * An iSpindel can't send headers, so the token is in its Token field (`token` in what it posts); a header
 * (Authorization: Bearer …) or ?token= works too, for other firmware.
 */
export function ispindelRoutes({ app, s, isOwner, owner, broadcast }: RouteContext): void {
  const usage = new Map<string, { since: number; posts: number }>();
  const { ispindel } = s;
  // Why posts were turned away, logged at most every 10 minutes per sender: an iSpindel set up wrongly keeps trying.
  const warned = new Map<string, number>();
  const warn = (ip: string, reason: string, extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    const key = `${ip} ${reason}`;
    if (now - (warned.get(key) ?? 0) < 10 * 60_000) return;
    warned.set(key, now);
    if (warned.size > 200) warned.clear();
    app.log.warn({ svc: 'ispindel', from: ip, ...extra }, `an iSpindel post was turned away: ${reason}`);
  };

  app.post(
    ISPINDEL_PATH,
    {
      bodyLimit: 8 * 1024,
      // What the hub couldn't even read (broken JSON, a body too big) is logged too, as an iSpindel can't say.
      errorHandler: (err: Error & { statusCode?: number }, req, reply) => {
        warn(req.ip, 'unreadable', { error: err.message });
        return reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 400).send({ error: err.message });
      },
    },
    async (req, reply) => {
      let body = req.body as unknown;
      // Some firmware sends JSON without saying so.
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          warn(req.ip, 'not JSON');
          return reply.code(400).send({ error: 'Send the reading as JSON' });
        }
      }
      const parsed = ispindelPostSchema.safeParse(body);
      const token =
        (parsed.success ? parsed.data.token : undefined) ??
        bearer(req.headers.authorization) ??
        (req.query as Record<string, string> | undefined)?.token;
      if (!ispindel.verify(token)) {
        warn(req.ip, token ? 'wrong token' : 'no token', { name: parsed.success ? parsed.data.name : undefined });
        return reply.code(401).send({
          error: "This needs the hub's iSpindel token (Add device → iSpindel) in the iSpindel's Token field.",
        });
      }
      if (!parsed.success) {
        const error = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
        warn(req.ip, 'not a reading', { error });
        return reply.code(400).send({ error });
      }
      const now = Date.now();
      let use = usage.get(token!);
      if (!use || now - use.since > 60_000) {
        use = { since: now, posts: 0 };
        usage.set(token!, use);
      }
      if (++use.posts > POSTS_PER_MINUTE)
        return reply.code(429).send({ error: 'Too many readings: an iSpindel sends one every few minutes' });
      for (const [k, u] of usage) if (now - u.since > 120_000) usage.delete(k);

      const result = ispindel.ingest(parsed.data, now, performance.now());
      if (!result.ok) {
        warn(req.ip, result.reason, { name: parsed.data.name });
        return reply.code(422).send({ error: `Reading not stored: ${result.reason}` });
      }
      return { ok: true, status: result.status };
    },
  );

  app.get('/api/ispindel', async (req) => ispindel.info(isOwner(req)));

  /** Look for iSpindels in setup mode now, and keep looking every few seconds while the dialog is open. */
  app.post('/api/ispindel/scan', owner, async () => {
    ispindel.watch();
    const hotspots = await ispindel.scan(true);
    return { hotspots, scannedAt: Date.now() };
  });

  app.get('/api/ispindel/setup', owner, async () => ispindel.setupProgress());

  app.post('/api/ispindel/setup', owner, async (req) => ispindel.startSetup(ispindelSetupSchema.parse(req.body)));

  app.delete('/api/ispindel/setup/:id', owner, async (req, reply) => {
    ispindel.forget((req.params as { id: string }).id);
    return reply.code(204).send();
  });

  ispindel.on('hotspots', (hotspots, scannedAt: number) => broadcast({ type: 'ispindel-hotspots', hotspots, scannedAt }));
  // Only the owner sees how a set-up is going (it names the Wi-Fi network), as with screens.
  ispindel.on('setup', (setup) => broadcast({ type: 'ispindel-setup', setup }, null));
}
