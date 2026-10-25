import { relayBodySchema } from '@rapthooker/shared';
import { bearer } from '../tokens.js';
import type { RouteContext } from './context.js';

/** A relay may post this many adverts a minute (a pill sends a short burst every interval). */
const ADVERTS_PER_MINUTE = 600;

/**
 * Adverts posted by Bluetooth relays (an ESP32 running ESPHome, or anything else that can hear RAPT Pills), fed into
 * the same pipeline as the hub's own Bluetooth. Needs a relay token: `Authorization: Bearer rh_relay_...`.
 */
export function relayRoutes({ app, s }: RouteContext): void {
  const usage = new Map<string, { since: number; adverts: number }>();

  app.post('/api/relay', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const token = bearer(req.headers.authorization);
    const relayToken = token ? s.tokens.verify(token, 'relay') : null;
    if (!relayToken) {
      return reply.code(401).send({ error: 'This needs a relay token (Settings → API tokens) as "Authorization: Bearer <token>".' });
    }
    const hub = s.scanner.relays;
    if (!hub) return reply.code(503).send({ error: "This hub doesn't take adverts from relays." });
    const body = relayBodySchema.parse(req.body);

    const now = Date.now();
    let use = usage.get(relayToken.id);
    if (!use || now - use.since > 60_000) {
      use = { since: now, adverts: 0 };
      usage.set(relayToken.id, use);
    }
    if (use.adverts + body.adverts.length > ADVERTS_PER_MINUTE) {
      return reply.code(429).send({ error: 'Too many adverts: send only RAPT Pill adverts, and repeats at most every few seconds.' });
    }
    use.adverts += body.adverts.length;
    for (const [id, u] of usage) if (now - u.since > 120_000) usage.delete(id);

    return hub.ingest(body.relay, body.adverts);
  });
}
