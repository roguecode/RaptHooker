import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const configSchema = z.object({
  /** `::` listens on every IPv6 and IPv4 address (mDNS names like rapthooker.local often resolve to IPv6 first). */
  host: z.string().default('::'),
  port: z.number().int().min(1).max(65535).default(8080),
  /** SQLite database, keys and secrets. */
  dataDir: z.string().default('./data'),
  /** The built web app. Defaults to web/dist next to the server. */
  webDir: z.string().optional(),
  bluetooth: z
    .object({
      /** Older single-adapter setting, e.g. hci0 (used when `adapters` is empty). */
      adapter: z
        .string()
        .regex(/^[A-Za-z0-9_]*$/, 'An adapter name like hci0')
        .default(''),
      /** BlueZ adapters to listen with, e.g. ["hci0", "hci1"]. Empty uses `adapter`, or else every adapter found. */
      adapters: z.array(z.string().regex(/^[A-Za-z0-9_]+$/, 'An adapter name like hci0')).default([]),
      /**
       * 'passive' listens without transmitting (kinder to a Pi 3's Wi-Fi; needs BlueZ experimental features), 'active'
       * uses ordinary discovery, 'auto' is passive when BlueZ offers it and active otherwise.
       */
      scanMode: z.enum(['auto', 'passive', 'active']).default('auto'),
      /** Simulated pills instead of Bluetooth (development). */
      mock: z.boolean().default(false),
    })
    .default({ adapter: '', adapters: [], scanMode: 'auto', mock: false }),
  /** Raw readings older than this are deleted (15-minute averages are kept). 0 keeps everything. */
  rawRetentionDays: z.number().int().min(0).default(0),
  auth: z
    .object({
      /** Tailscale logins allowed owner access through `tailscale serve`. Empty means anyone on your tailnet. */
      allowedTailscaleUsers: z.array(z.string()).default([]),
      /** Treat requests from this machine as the owner. Development only. */
      trustLocalhost: z.boolean().default(false),
    })
    .default({ allowedTailscaleUsers: [], trustLocalhost: false }),
  backup: z
    .object({
      /** Where the daily backups go. Empty: <dataDir>/backups. */
      dir: z.string().default(''),
      time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default('03:15'),
      /** How many daily backups to keep on the hub. */
      keep: z.number().int().min(1).default(7),
    })
    .default({ dir: '', time: '03:15', keep: 7 }),
  push: z
    .object({
      /** Contact for push services (mailto: or https: URL). */
      subject: z.string().default('mailto:rapthooker@example.com'),
    })
    .default({ subject: 'mailto:rapthooker@example.com' }),
  clock: z
    .object({
      /**
       * Without a real-time clock a Pi boots with a stale time until NTP syncs. Readings are held until then
       * (and stamped from a monotonic clock), for at most this long.
       */
      maxSyncWaitMin: z.number().min(0).default(10),
    })
    .default({ maxSyncWaitMin: 10 }),
});

export type Config = z.infer<typeof configSchema> & { webDir: string };

export function parseConfig(raw: unknown, baseDir: string, defaultWebDir: string): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }
  const c = result.data;
  return {
    ...c,
    dataDir: resolve(baseDir, c.dataDir),
    webDir: c.webDir ? resolve(baseDir, c.webDir) : defaultWebDir,
    backup: { ...c.backup, dir: c.backup.dir ? resolve(baseDir, c.backup.dir) : '' },
  };
}

export function applyEnv(config: Config, env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.RAPTHOOKER_PORT?.trim();
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid RAPTHOOKER_PORT: ${port}`);
    config.port = n;
  }
  const dataDir = env.RAPTHOOKER_DATA_DIR?.trim();
  if (dataDir) config.dataDir = resolve(dataDir);
  return config;
}

/** Without a config file: simulated pills, data in ./data and this machine trusted as the owner. */
export const DEV_CONFIG = { bluetooth: { mock: true }, auth: { trustLocalhost: true } };

/** Loads RAPTHOOKER_CONFIG or ./rapthooker.config.json, or the development defaults. */
export function loadConfig(defaultWebDir: string): { config: Config; path: string | null } {
  const path = process.env.RAPTHOOKER_CONFIG ?? resolve(process.cwd(), 'rapthooker.config.json');
  if (!existsSync(path)) {
    if (process.env.RAPTHOOKER_CONFIG) throw new Error(`Config file not found: ${path}`);
    return { config: applyEnv(parseConfig(DEV_CONFIG, process.cwd(), defaultWebDir)), path: null };
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return { config: applyEnv(parseConfig(raw, dirname(path), defaultWebDir)), path };
}
