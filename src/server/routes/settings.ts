import { existsSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { hubSettingsSchema, settingsBodySchema, type HubSettings, type HubStatus } from '@rapthooker/shared';
import type { RouteContext } from './context.js';

export function settingsRoutes({ app, s, owner }: RouteContext): void {
  const { store, pills, settings } = s;

  app.get('/api/settings', async () => ({ units: settings.units(), ignored: pills.ignoredAddresses() }));

  app.put('/api/settings', owner, async (req) => {
    const body = settingsBodySchema.parse(req.body);
    settings.setUnits(body.units);
    return { units: settings.units(), ignored: pills.ignoredAddresses() };
  });

  app.get('/api/settings/hub', async (): Promise<HubSettings> => settings.hub());

  app.put('/api/settings/hub', owner, async (req): Promise<HubSettings> => settings.setHub(hubSettingsSchema.parse(req.body)));

  let rowCache = { at: 0, n: 0 };
  app.get('/api/status', async (): Promise<HubStatus> => {
    const now = Date.now();
    if (now - rowCache.at > 5 * 60_000) rowCache = { at: now, n: store.countReadings() };
    const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
    return {
      version: s.version,
      startedAt: s.startedAt,
      now,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      hostname: hostname(),
      clockSynced: s.clock.trusted,
      ble: s.scanner.status,
      dbSizeBytes: size(store.path) + size(`${store.path}-wal`),
      readings: rowCache.n,
      lastBackup: s.maintenance.lastBackup,
      backupError: s.maintenance.backupError,
      backups: s.maintenance.status(),
      disk: s.system.disk(),
      warnings: s.system.warnings(),
      mqtt: s.mqtt.status,
      update: s.updates.info(),
    };
  });
}
