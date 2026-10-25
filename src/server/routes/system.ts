import QRCode from 'qrcode';
import { z } from 'zod';
import type { HubAddress, LogEntry } from '@rapthooker/shared';
import { buildDiagnostics } from '../system/diagnostics.js';
import type { RouteContext } from './context.js';

/** A hub address with a QR code (SVG markup) to scan with a phone. */
export type HubAddressWithQr = HubAddress & { qrSvg: string };

const logsQuerySchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Hub addresses with QR codes, the log viewer, restarting and the diagnostics bundle. */
export function systemRoutes({ app, s, owner, isOwner }: RouteContext): void {
  const qrCache = new Map<string, string>();
  const qr = async (url: string): Promise<string> => {
    let svg = qrCache.get(url);
    if (!svg) {
      svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      if (qrCache.size > 50) qrCache.clear();
      qrCache.set(url, svg);
    }
    return svg;
  };

  // Viewers have reached the hub already, so its LAN addresses are no secret; the Tailscale name is for the owner only.
  app.get('/api/system/addresses', async (req): Promise<HubAddressWithQr[]> => {
    const addresses = await s.system.addresses({ tailscale: isOwner(req) });
    return Promise.all(addresses.map(async (a) => ({ ...a, qrSvg: await qr(a.url) })));
  });

  app.get('/api/system/logs', owner, async (req, reply): Promise<LogEntry[]> => {
    const q = logsQuerySchema.parse(req.query);
    reply.header('Cache-Control', 'no-store');
    return s.logs.list(q.level, q.limit);
  });

  app.post('/api/system/restart', owner, async (_req, reply) => {
    if (!s.system.restart()) return reply.code(503).send({ error: "This hub can't restart itself: stop and start it by hand." });
    return reply.code(202).send({ restarting: true, supervised: s.system.supervised });
  });

  app.get('/api/system/diagnostics', owner, async (_req, reply) => {
    const now = new Date();
    const body = JSON.stringify(buildDiagnostics(s, now.getTime()), null, 2);
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="rapthooker-diagnostics-${localDate(now)}.json"`)
      .header('Cache-Control', 'no-store')
      .send(body);
  });
}
