import { existsSync, readFileSync } from 'node:fs';
import { arch, cpus, freemem, hostname, loadavg, release, totalmem, uptime } from 'node:os';
import type { LogEntry } from '@rapthooker/shared';
import type { Services } from '../server.js';
import { KEG_COMPANY_ID, RAPT_COMPANY_ID } from '../ble/rapt.js';
import { makeScrubber, REDACTED, type Replacement, type Scrubber } from './scrub.js';

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const readText = (path: string) => safe(() => (existsSync(path) ? readFileSync(path, 'utf8') : ''), '');

/** "Raspberry Pi 3 Model B Rev 1.2", or null off a Pi. */
function boardModel(): string | null {
  const model = readText('/proc/device-tree/model') || readText('/sys/firmware/devicetree/base/model');
  return model.replace(/\0/g, '').trim() || null;
}

function osName(): string | null {
  return /^PRETTY_NAME="?([^"\n]*)"?/m.exec(readText('/etc/os-release'))?.[1] ?? null;
}

const companyName = (id: number) => (id === RAPT_COMPANY_ID ? 'RAPT' : id === KEG_COMPANY_ID ? 'KegLand' : 'other');

/** Version 1 RAPT readings carry the pill's MAC address (bytes 3–8): zeroed. */
export function maskPayload(companyId: number, hex: string | null): string | null {
  if (!hex || companyId !== RAPT_COMPANY_ID || !hex.toLowerCase().startsWith('505401')) return hex;
  return `${hex.slice(0, 6)}${'0'.repeat(12)}${hex.slice(18)}`;
}

/** Neutral labels for everything people name or that identifies them, so the bundle can still tell things apart. */
function labels(s: Services) {
  const pills = safe(() => s.pills.list(), []);
  const pillLabel = new Map<string, string>();
  const replacements: Replacement[] = [];
  pills.forEach((p, i) => {
    const label = `pill ${i + 1}`;
    pillLabel.set(p.id, label);
    pillLabel.set(p.address.toUpperCase(), label);
    replacements.push({ find: p.id, label }, { find: p.address, label }, { find: p.raptId, label }, { find: p.name, label });
    if (p.brew) replacements.push({ find: p.brew.name, label: `brew on ${label}` });
  });
  const nearby = safe(() => s.pills.nearby(), []);
  const deviceLabel = (address: string) => {
    const key = address.toUpperCase();
    let label = pillLabel.get(key);
    if (!label) {
      label = `device ${[...pillLabel.values()].filter((l) => l.startsWith('device ')).length + 1}`;
      pillLabel.set(key, label);
    }
    return label;
  };
  nearby.forEach((n) =>
    replacements.push({ find: n.address, label: deviceLabel(n.address) }, { find: n.raptId, label: deviceLabel(n.address) }),
  );
  const named = (kind: string, items: { name: string }[]) =>
    items.forEach((x, i) => replacements.push({ find: x.name, label: `${kind} ${i + 1}` }));
  const webhooks = safe(() => s.webhooks.list(), []);
  const channels = safe(() => s.channels.list(), []);
  const rules = safe(() => s.alerts.list(), []);
  const tokens = safe(() => s.tokens.list(), []);
  const relays = s.scanner.status.relays ?? [];
  named('webhook', webhooks);
  named('channel', channels);
  named('alert', rules);
  named('token', tokens);
  named('relay', relays);
  const hubName = safe(() => s.settings.hub().name, '');
  if (hubName && hubName !== 'RaptHooker') replacements.push({ find: hubName, label: 'the hub' });
  return { pills, nearby, webhooks, channels, rules, tokens, relays, replacements, deviceLabel };
}

const scrubLog = (scrub: Scrubber) => (e: LogEntry) => ({
  at: new Date(e.at).toISOString(),
  level: e.level,
  svc: e.svc,
  msg: scrub(e.msg),
  detail: e.detail ? scrub(e.detail) : null,
});

/**
 * Everything useful for working out what's wrong with a hub, with nothing personal or secret in it: no Bluetooth or
 * IP addresses, names, web addresses, tokens or passwords. Safe to attach to a GitHub issue.
 */
export function buildDiagnostics(s: Services, now = Date.now()) {
  const l = labels(s);
  const scrub = makeScrubber(l.replacements, hostname());
  const scrubOrNull = (text: string | null | undefined) => (text ? scrub(text) : null);
  const { config, system, store } = s;
  const ble = s.scanner.status;
  const mqttSettings = safe(() => s.settings.mqtt(), null);
  const backupSettings = safe(() => s.settings.backups(), null);
  const update = safe(() => s.updates.info(), null);
  const mem = process.memoryUsage();

  return {
    app: 'rapthooker',
    kind: 'diagnostics',
    version: 1,
    generatedAt: new Date(now).toISOString(),
    note: 'Bluetooth and IP addresses, names, web addresses, tokens and passwords have been taken out.',
    hub: {
      version: s.version,
      startedAt: new Date(s.startedAt).toISOString(),
      uptimeSec: Math.round((now - s.startedAt) / 1000),
      node: process.version,
      platform: `${process.platform}/${arch()}`,
      kernel: release(),
      os: osName(),
      board: boardModel(),
      hostnameIsDefault: /^rapthooker$/i.test(hostname()),
      systemUptimeSec: Math.round(uptime()),
      supervised: system.supervised,
      cpus: cpus().length,
      loadAvg: loadavg().map((n) => Math.round(n * 100) / 100),
      memory: { totalBytes: totalmem(), freeBytes: freemem(), rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      eventLoop: system.loopStats(),
    },
    status: {
      clockSynced: s.clock.trusted,
      database: {
        schemaVersion: safe(() => store.schemaVersion, null),
        readings: safe(() => store.countReadings(), null),
        disk: system.disk(),
      },
      warnings: system.warnings().map((w) => ({ ...w, message: scrub(w.message) })),
      backups: {
        settings: backupSettings && {
          usb: backupSettings.usb,
          s3: backupSettings.s3.enabled,
          s3Endpoint: backupSettings.s3.endpoint ? scrub(backupSettings.s3.endpoint) : null,
          weeklyCsv: backupSettings.weeklyCsv,
        },
        targets: safe(() => s.maintenance.status(), []).map((b) => ({
          target: b.target,
          at: b.at ? new Date(b.at).toISOString() : null,
          ok: b.ok,
          error: scrubOrNull(b.error),
        })),
      },
      mqtt: {
        enabled: mqttSettings?.enabled ?? null,
        scheme: mqttSettings?.url ? (/^(\w+):/.exec(mqttSettings.url)?.[1] ?? null) : null,
        discovery: mqttSettings?.discovery ?? null,
        retain: mqttSettings?.retain ?? null,
        state: s.mqtt.status.state,
        error: scrubOrNull(s.mqtt.status.error),
        lastPublishAt: s.mqtt.status.lastPublishAt ? new Date(s.mqtt.status.lastPublishAt).toISOString() : null,
      },
      update: update && {
        current: update.current,
        latest: update.latest,
        available: update.available,
        checkedAt: update.checkedAt ? new Date(update.checkedAt).toISOString() : null,
        error: scrubOrNull(update.error),
        canSelfUpdate: update.canSelfUpdate,
        devBuild: update.devBuild && {
          ...update.devBuild,
          builtAt: update.devBuild.builtAt ? new Date(update.devBuild.builtAt).toISOString() : null,
        },
        canSwitchToRelease: update.canSwitchToRelease,
        state: update.state,
      },
    },
    ble: {
      state: ble.state,
      adapters: ble.adapters,
      mode: ble.mode,
      error: scrubOrNull(ble.error),
      lastAdvertAgoSec: ble.lastAdvertAt ? Math.round((now - ble.lastAdvertAt) / 1000) : null,
      sinceSec: Math.round((now - ble.since) / 1000),
      relays: l.relays.map((r, i) => ({ relay: `relay ${i + 1}`, lastAgoSec: Math.round((now - r.lastAt) / 1000), adverts: r.adverts })),
    },
    pills: l.pills.map((p, i) => ({
      pill: `pill ${i + 1}`,
      kind: p.kind,
      archived: p.archived,
      info: p.info,
      offsets: p.offsets,
      model: {
        gravitySource: p.model.gravitySource,
        tiltPoints: p.model.tiltPoints.length,
        velocitySource: p.model.velocitySource,
        velocityHours: p.model.velocityHours,
        smoothing: p.model.smoothing,
      },
      live: {
        online: p.live.online,
        lastHeardAgoSec: p.live.lastHeardAt ? Math.round((now - p.live.lastHeardAt) / 1000) : null,
        lastReadingAgoSec: p.live.lastReadingAt ? Math.round((now - p.live.lastReadingAt) / 1000) : null,
        rssi: p.live.rssi,
        intervalSec: p.live.intervalSec,
        caught: p.live.caught,
        latest: p.live.latest && {
          gravity: p.live.latest.gravity,
          pillGravity: p.live.latest.pillGravity,
          temperature: p.live.latest.temperature,
          velocity: p.live.latest.velocity,
          battery: p.live.latest.battery,
          tilt: p.live.latest.tilt,
          plausible: p.live.latest.plausible,
        },
      },
      brew: p.brew && {
        startedAgoSec: Math.round((now - p.brew.startedAt) / 1000),
        readings: p.brew.stats.readings,
        stable: p.brew.stats.stable,
        stage: p.brew.stats.prediction?.stage ?? null,
      },
    })),
    nearby: l.nearby.map((n) => ({
      device: l.deviceLabel(n.address),
      kind: n.kind,
      rssi: n.rssi,
      lastHeardAgoSec: Math.round((now - n.lastHeardAt) / 1000),
      info: n.info,
    })),
    webhooks: l.webhooks.map((h, i) => ({
      webhook: `webhook ${i + 1}`,
      preset: h.preset,
      enabled: h.enabled,
      method: h.method,
      bodyFormat: h.bodyFormat,
      intervalMin: h.intervalMin,
      pills: h.pillIds === 'all' ? 'all' : h.pillIds.length,
      batch: h.batch,
      catchUp: h.catchUp,
      skipImplausible: h.skipImplausible,
      paused: h.pausedUntil !== null && h.pausedUntil > now,
      status: {
        lastAt: h.status.lastAt ? new Date(h.status.lastAt).toISOString() : null,
        lastOk: h.status.lastOk,
        lastHttpStatus: h.status.lastHttpStatus,
        lastError: scrubOrNull(h.status.lastError),
        sent24h: h.status.sent24h,
        failed24h: h.status.failed24h,
      },
    })),
    channels: l.channels.map((c, i) => ({
      channel: `channel ${i + 1}`,
      kind: c.kind,
      enabled: c.enabled,
      lastAt: c.lastAt ? new Date(c.lastAt).toISOString() : null,
      lastOk: c.lastOk,
      lastError: scrubOrNull(c.lastError),
    })),
    alerts: l.rules.map((r, i) => ({
      alert: `alert ${i + 1}`,
      kind: r.kind,
      enabled: r.enabled,
      firingFor: r.active.length,
      channels: r.channelIds === 'all' ? 'all' : r.channelIds.length,
    })),
    tokens: l.tokens.map((t) => ({ scope: t.scope, usedAgoSec: t.lastUsedAt ? Math.round((now - t.lastUsedAt) / 1000) : null })),
    config: {
      host: ['::', '0.0.0.0', '127.0.0.1', '::1'].includes(config.host) ? config.host : REDACTED,
      port: config.port,
      dataDir: scrub(config.dataDir),
      webDir: scrub(config.webDir),
      bluetooth: config.bluetooth,
      rawRetentionDays: config.rawRetentionDays,
      auth: { allowedTailscaleUsers: config.auth.allowedTailscaleUsers.length, trustLocalhost: config.auth.trustLocalhost },
      backup: { dir: config.backup.dir ? scrub(config.backup.dir) : '', time: config.backup.time, keep: config.backup.keep },
      clock: config.clock,
    },
    adverts: system.recentAdverts().map((a) => ({
      agoSec: Math.round((now - a.at) / 1000),
      device: l.deviceLabel(a.address),
      rssi: a.rssi,
      cached: a.cached,
      data: a.data.map((d) => ({
        company: companyName(d.companyId),
        companyId: `0x${d.companyId.toString(16).padStart(4, '0')}`,
        hex: maskPayload(d.companyId, d.hex),
        length: d.length,
      })),
    })),
    logs: s.logs.list('debug', 500).map(scrubLog(scrub)),
  };
}

export type Diagnostics = ReturnType<typeof buildDiagnostics>;
