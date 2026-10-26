import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { BackupTargetStatus, BleStatus, LogEntry, Pill } from '@rapthooker/shared';
import { parseConfig } from '../config.js';
import { SystemService, type SystemDeps } from '../system.js';
import { SystemdNotifier, type ExecFn } from '../system/notify.js';
import { compactionDue, dbPages, emergencyCleanup, planCompaction } from '../system/compaction.js';
import { listAddresses, tailscaleDnsName, tailscaleServeUrl } from '../system/addresses.js';
import { makeScrubber } from '../system/scrub.js';
import { buildDiagnostics, maskPayload } from '../system/diagnostics.js';
import { systemRoutes } from '../routes/system.js';
import { LogBuffer } from '../logbuffer.js';
import { RAPT_COMPANY_ID } from '../ble/rapt.js';
import type { RouteContext } from '../routes/context.js';
import type { Services } from '../server.js';
import { COMPACT_AFTER_UPGRADE_KEY, type Store } from '../db.js';
import type { Advert } from '../ble/scanner.js';
import { CAPTURED, silent, tempStore } from './helpers.js';

const MB = 1024 ** 2;
const DAY = 86_400_000;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
});

function fakeExec(outputs: Record<string, string | Error> = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args });
    const out = outputs[`${file} ${args.join(' ')}`];
    if (out instanceof Error) throw out;
    return { stdout: out ?? '' };
  };
  return { exec, calls };
}

function bleStatus(patch: Partial<BleStatus> = {}): BleStatus {
  return {
    state: 'scanning',
    adapter: 'hci0',
    adapters: ['hci0'],
    mode: 'passive',
    error: null,
    lastAdvertAt: null,
    since: 0,
    relays: [],
    ...patch,
  };
}

function setup(deps: SystemDeps = {}, configPatch: Record<string, unknown> = {}) {
  const t = tempStore();
  const config = parseConfig({ dataDir: t.dir, ...configPatch }, t.dir, t.dir);
  const system = new SystemService(config, t.store, silent, {
    exists: () => false,
    statfs: () => ({ bsize: 4096, blocks: (32 * 1024 * MB) / 4096, bavail: (16 * 1024 * MB) / 4096 }),
    ...deps,
  });
  cleanup = () => {
    system.stop();
    t.cleanup();
  };
  return { system, store: t.store, config, dir: t.dir };
}

const freeDisk = (bytes: number) => () => ({ bsize: 4096, blocks: (32 * 1024 * MB) / 4096, bavail: Math.floor(bytes / 4096) });

describe('systemd notifications', () => {
  it('does nothing unless systemd started the hub', async () => {
    vi.useFakeTimers();
    const { exec, calls } = fakeExec();
    const { system } = setup({ exec, env: {} });
    system.ready();
    system.pingWatchdog();
    await vi.advanceTimersByTimeAsync(120_000);
    system.stop();
    expect(calls).toEqual([]);
    expect(system.supervised).toBe(false);
  });

  it('says ready, then pings the watchdog every 20 s from the main loop', async () => {
    vi.useFakeTimers();
    const { exec, calls } = fakeExec();
    const { system } = setup({ exec, env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '60000000' } });
    system.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toMatchObject({ file: 'systemd-notify' });
    expect(calls[0]!.args).toContain('READY=1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((c) => c.args.includes('WATCHDOG=1'))).toHaveLength(3);
    system.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)!.args).toContain('STOPPING=1');
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(before);
    expect(system.supervised).toBe(true);
  });

  it('pings at a third of a shorter watchdog timeout, and never throws when systemd-notify fails', async () => {
    const failing: ExecFn = async () => {
      throw new Error('spawn systemd-notify ENOENT');
    };
    const n = new SystemdNotifier(silent, failing, { NOTIFY_SOCKET: '@/notify', WATCHDOG_USEC: '30000000' });
    expect(n.pingEveryMs).toBe(10_000);
    await expect(n.notify('WATCHDOG=1')).resolves.toBe(false);
    expect(new SystemdNotifier(silent, failing, { NOTIFY_SOCKET: '@/notify' }).pingEveryMs).toBe(20_000);
    expect(new SystemdNotifier(silent, failing, {}).enabled).toBe(false);
  });
});

describe('warnings', () => {
  it('warns about low and critical disk space', () => {
    expect(setup({ statfs: freeDisk(300 * MB) }).system.warnings()).toEqual([expect.objectContaining({ id: 'disk-low', level: 'warn' })]);
    cleanup?.();
    expect(setup({ statfs: freeDisk(50 * MB) }).system.warnings()).toEqual([
      expect.objectContaining({ id: 'disk-critical', level: 'error' }),
    ]);
  });

  it('reports disk and database sizes', () => {
    const { system } = setup();
    const disk = system.disk()!;
    expect(disk.totalBytes).toBe(32 * 1024 * MB);
    expect(disk.freeBytes).toBe(16 * 1024 * MB);
    expect(disk.dbBytes).toBeGreaterThan(0);
    expect(disk.dataBytes).toBeGreaterThanOrEqual(disk.dbBytes);
  });

  it('warns about the clock, Bluetooth, failed backups and a slow event loop', () => {
    let trusted = false;
    const listeners: ((info: { synced: boolean }) => void)[] = [];
    const clock = {
      get trusted() {
        return trusted;
      },
      on: (_e: 'trusted', fn: (info: { synced: boolean }) => void) => listeners.push(fn),
    };
    const scanner = {
      status: bleStatus({ state: 'error', error: 'adapter hci0 is powered off' }),
      on: () => undefined,
      off: () => undefined,
    };
    const backups: BackupTargetStatus[] = [
      { target: 'local', at: null, ok: false, error: 'Backups are off (set backup.dir in the config file)', file: null },
      { target: 'usb', at: 1, ok: false, error: 'Backup failed: no space left on device', file: null },
      { target: 's3', at: 1, ok: true, error: null, file: 'x' },
    ];
    const { system } = setup({ clock, scanner, maintenance: { running: false, status: () => backups } });
    const ids = () => system.warnings().map((w) => w.id);
    expect(ids()).toEqual(['clock-waiting', 'ble-error', 'backup-failed-usb']);
    expect(system.warnings().find((w) => w.id === 'backup-failed-usb')!.message).toContain('no space left on device');

    trusted = true;
    listeners.forEach((fn) => fn({ synced: false }));
    expect(ids()).toContain('clock-not-synced');

    system.checkLoop(1500, 2500);
    system.checkLoop(1800, 3000);
    expect(ids()).not.toContain('event-loop-slow');
    system.checkLoop(1200, 2000);
    expect(ids()).toContain('event-loop-slow');
    system.checkLoop(5, 20);
    expect(ids()).not.toContain('event-loop-slow');
  });

  it('suggests raw retention for a big database', () => {
    const { system } = setup();
    expect(system.warnings()).toEqual([]);
    vi.spyOn(system, 'disk').mockReturnValue({
      totalBytes: 1,
      freeBytes: 8 * 1024 * MB,
      dataBytes: 2 * 1024 * MB,
      dbBytes: 1.5 * 1024 * MB,
    });
    expect(system.warnings()).toEqual([
      expect.objectContaining({ id: 'db-large', level: 'info', message: expect.stringContaining('rawRetentionDays') }),
    ]);
  });
});

function fillAndDelete(store: Store, rows = 3000) {
  const insert = store.db.prepare(
    'INSERT INTO webhook_deliveries (webhook_id, pill_id, at, ok, status, duration_ms, method, url, request_body) VALUES (?, ?, ?, 1, 200, 5, ?, ?, ?)',
  );
  store.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run('w', 'p', i, 'POST', 'https://example.com/hook', 'x'.repeat(1500));
  });
  store.db.exec('DELETE FROM webhook_deliveries');
}

describe('database compaction', () => {
  it('only compacts with lots of unused space and room on the disk', () => {
    const pages = { pageSize: 4096, pageCount: 1000, freelistCount: 300 };
    expect(planCompaction({ ...pages, freelistCount: 150 }, 4 * MB, 1024 * MB).run).toBe(false);
    expect(planCompaction(pages, 4 * MB, 1024 * MB).run).toBe(true);
    expect(planCompaction(pages, 4 * MB, 7 * MB)).toMatchObject({ run: false, reason: expect.stringContaining('disk space') });
    expect(planCompaction(pages, 4 * MB, null).run).toBe(false);
    expect(planCompaction(pages, 2 * 1024 ** 3, 100 * 1024 ** 3).run).toBe(false);
    expect(planCompaction({ ...pages, pageCount: 0, freelistCount: 0 }, 0, 1024 * MB).run).toBe(false);
  });

  it('runs once a week, in the quiet hours after the nightly backup', () => {
    const at = (h: number, m: number) => new Date(2026, 9, 21, h, m);
    expect(compactionDue(at(3, 50), '03:15', 0)).toBe(true);
    expect(compactionDue(at(3, 30), '03:15', 0)).toBe(false);
    expect(compactionDue(at(6, 40), '03:15', 0)).toBe(true);
    expect(compactionDue(at(7, 0), '03:15', 0)).toBe(false);
    expect(compactionDue(at(14, 0), '03:15', 0)).toBe(false);
    expect(compactionDue(at(3, 50), '03:15', at(3, 50).getTime() - 3 * DAY)).toBe(false);
    expect(compactionDue(at(3, 50), '03:15', at(3, 50).getTime() - 7 * DAY)).toBe(true);
    // A backup late in the evening: the quiet hours run past midnight.
    expect(compactionDue(at(1, 0), '23:30', 0)).toBe(true);
  });

  it('compacts the database, giving the watchdog longer meanwhile', async () => {
    const { exec, calls } = fakeExec();
    const { system, store } = setup({ exec, env: { NOTIFY_SOCKET: '@/notify', WATCHDOG_USEC: '60000000' } });
    fillAndDelete(store);
    expect(dbPages(store.db).freelistCount / dbPages(store.db).pageCount).toBeGreaterThan(0.2);
    const outcome = await system.compact();
    expect(outcome).toMatchObject({ ran: true });
    expect(outcome.reclaimedBytes).toBeGreaterThan(MB);
    expect(dbPages(store.db).freelistCount).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    const sent = calls.map((c) => c.args.join(' '));
    expect(sent[0]).toContain('WATCHDOG_USEC=900000000');
    expect(sent.at(-1)).toContain('WATCHDOG_USEC=60000000');
    // Recorded before it started, so a VACUUM that's cut short isn't tried again every night.
    expect(Number(store.getMeta('lastCompactionCheck'))).toBeGreaterThan(0);
  });

  it("doesn't compact when it can't give the watchdog longer", async () => {
    const failing: ExecFn = async () => {
      throw new Error('systemd-notify timed out');
    };
    const { system, store } = setup({ exec: failing, env: { NOTIFY_SOCKET: '@/notify', WATCHDOG_USEC: '60000000' } });
    fillAndDelete(store);
    const before = dbPages(store.db).freelistCount;
    expect(await system.compact()).toMatchObject({ ran: false, retry: true });
    expect(dbPages(store.db).freelistCount).toBe(before);
  });

  it("doesn't compact during a backup, without the disk space, or when it isn't needed", async () => {
    let busy = true;
    const { system, store } = setup({
      maintenance: {
        get running() {
          return busy;
        },
        status: () => [],
      },
    });
    fillAndDelete(store);
    expect(await system.compact()).toMatchObject({ ran: false, retry: true });
    busy = false;
    cleanup?.();
    const tight = setup({ statfs: freeDisk(MB) });
    fillAndDelete(tight.store);
    expect(await tight.system.compact()).toMatchObject({ ran: false, retry: false, reason: expect.stringContaining('disk space') });
    cleanup?.();
    const tidy = setup();
    expect(await tidy.system.compact()).toMatchObject({ ran: false, retry: false });
  });

  it('compacts soon after an update upgraded the database, once the installer has seen the hub answer', async () => {
    vi.useFakeTimers();
    // Mid-afternoon: not the weekly check's quiet hours.
    vi.setSystemTime(new Date(2026, 9, 21, 14, 0));
    const { system, store } = setup();
    fillAndDelete(store);
    store.setMeta(COMPACT_AFTER_UPGRADE_KEY, '4');
    const free = () => dbPages(store.db).freelistCount;
    expect(free()).toBeGreaterThan(0);
    system.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(free()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(free()).toBe(0);
    expect(store.getMeta(COMPACT_AFTER_UPGRADE_KEY)).toBeNull();
  });

  it('frees space in an emergency without touching readings', () => {
    const { system, store } = setup({ statfs: freeDisk(50 * MB) });
    const now = Date.now();
    const old = now - 30 * DAY;
    store.db
      .prepare(
        'INSERT INTO webhook_deliveries (webhook_id, at, ok, duration_ms, method, url) VALUES (?, ?, 1, 1, ?, ?), (?, ?, 1, 1, ?, ?)',
      )
      .run('w', old, 'POST', 'u', 'w', now, 'POST', 'u');
    store.db
      .prepare('INSERT INTO alert_events (rule_id, rule_name, pill_id, at, kind, message) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)')
      .run('r', 'n', 'p', old, 'fired', 'm', 'r', 'n', 'p', now, 'fired', 'm');
    store.db
      .prepare(
        'INSERT INTO readings (pill_id, ts, sg, temp, velocity, battery, rssi, x, y, z) VALUES (?, ?, 1.05, 20, NULL, 90, -60, 0, 0, 1)',
      )
      .run('p', old);
    expect(system.checkDiskSpace()).toEqual({ deliveries: 1, alertEvents: 1 });
    const count = (table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('webhook_deliveries')).toBe(1);
    expect(count('alert_events')).toBe(1);
    expect(count('readings')).toBe(1);
    // At most hourly.
    expect(system.checkDiskSpace()).toBeNull();
    expect(emergencyCleanup(store, now)).toEqual({ deliveries: 0, alertEvents: 0 });
  });
});

describe('addresses', () => {
  const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null });
  const v6 = (address: string) => ({ address, family: 'IPv6' as const, internal: false, netmask: '', mac: '', cidr: null, scopeid: 0 });
  const interfaces = {
    lo: [v4('127.0.0.1', true)],
    eth0: [v4('192.168.1.50'), v6('2001:db8::50'), v6('fe80::1')],
    wlan0: [v4('192.168.1.51')],
    tailscale0: [v4('100.100.100.100'), v6('fd7a:115c:a1e0::1')],
    docker0: [v4('172.17.0.1')],
  };

  it('lists LAN IPv4 addresses first, then the .local name and the Tailscale URL', () => {
    expect(listAddresses({ interfaces, hostname: 'rapthooker', port: 8080, tailscaleUrl: 'https://rapthooker.example.ts.net' })).toEqual([
      { kind: 'lan', url: 'http://192.168.1.50:8080' },
      { kind: 'lan', url: 'http://192.168.1.51:8080' },
      { kind: 'mdns', url: 'http://rapthooker.local:8080' },
      { kind: 'tailscale', url: 'https://rapthooker.example.ts.net' },
    ]);
  });

  it('uses global and unique-local IPv6 only without IPv4', () => {
    const v6only = { eth0: [v6('fe80::1'), v6('2001:db8::50'), v6('fd00::7')], tailscale0: [v6('fd7a:115c:a1e0::1')] };
    expect(listAddresses({ interfaces: v6only, hostname: 'rapthooker.lan', port: 80, tailscaleUrl: null })).toEqual([
      { kind: 'lan', url: 'http://[2001:db8::50]' },
      { kind: 'lan', url: 'http://[fd00::7]' },
      { kind: 'mdns', url: 'http://rapthooker.local' },
    ]);
  });

  it('reads the Tailscale name and serve status', () => {
    expect(tailscaleDnsName(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'rapthooker.example.ts.net.' } }))).toBe(
      'rapthooker.example.ts.net',
    );
    expect(tailscaleDnsName(JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'x.ts.net.' } }))).toBeNull();
    expect(tailscaleDnsName('not json')).toBeNull();
    expect(tailscaleServeUrl('{}', 'h.example.ts.net')).toBeNull();
    expect(tailscaleServeUrl(JSON.stringify({ Web: { 'h.example.ts.net:443': {} } }), 'h.example.ts.net')).toBe('https://h.example.ts.net');
    expect(tailscaleServeUrl(JSON.stringify({ Web: { 'h.example.ts.net:8443': {} } }), 'h.example.ts.net')).toBe(
      'https://h.example.ts.net:8443',
    );
    expect(tailscaleServeUrl(null, 'h.example.ts.net')).toBeUndefined();
  });

  it('asks Tailscale once every few minutes, and leaves it out when it fails or for viewers', async () => {
    const { exec, calls } = fakeExec({
      'tailscale status --json': JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'rapthooker.example.ts.net.' } }),
      'tailscale serve status --json': new Error('access denied'),
    });
    const { system } = setup({ exec, interfaces: () => interfaces, hostname: () => 'rapthooker' });
    const urls = async (tailscale?: boolean) => (await system.addresses({ tailscale })).map((a) => a.url);
    expect(await urls()).toContain('https://rapthooker.example.ts.net');
    expect(await urls(false)).not.toContain('https://rapthooker.example.ts.net');
    await urls();
    expect(calls.filter((c) => c.args[0] === 'status')).toHaveLength(1);
    cleanup?.();

    const missing = setup({ exec: fakeExec({ 'tailscale status --json': new Error('ENOENT') }).exec, interfaces: () => interfaces });
    expect((await missing.system.addresses()).map((a) => a.kind)).not.toContain('tailscale');
  });
});

/** Services with just what the diagnostics bundle reads. */
function fakeServices(
  base: { system: SystemService; store: Store; config: ReturnType<typeof parseConfig> },
  patch: Record<string, unknown> = {},
) {
  return {
    ...base,
    logs: new LogBuffer(),
    scanner: { status: bleStatus(), on: () => undefined, off: () => undefined },
    clock: { trusted: true },
    version: 't',
    startedAt: Date.now() - 1000,
    pills: { list: () => [], nearby: () => [] },
    webhooks: { list: () => [] },
    channels: { list: () => [] },
    alerts: { list: () => [] },
    tokens: { list: () => [] },
    settings: {
      hub: () => ({ name: 'RaptHooker' }),
      mqtt: () => ({ enabled: false, url: '', discovery: true, retain: true }),
      backups: () => ({ usb: true, s3: { enabled: false, endpoint: '' }, weeklyCsv: true }),
    },
    updates: { info: () => null },
    maintenance: { status: () => [] },
    mqtt: { status: { state: 'off', error: null, lastPublishAt: null } },
    ...patch,
  } as unknown as Services;
}

// Built at run time so they don't look like real credentials in the source.
const userInfo = ['user', 'hunter2'].join(':');
const bearer = ['Bearer', 'rh_read_AbCdEf123456'].join(' ');

describe('diagnostics', () => {
  const secrets = [
    '08:B6:1F:00:00:66',
    '08:B6:1F:00:00:64',
    '08b61f000066',
    'dev_08_B6_1F_00_00_66',
    '192.168.1.50',
    '2001:db8::50',
    'brewer@example.com',
    'sekrit-token-value',
    'rh_read_AbCdEf123456',
    'hunter2',
    'Fermenter Alpha',
    'MyHookName',
    'abcDEF1234567890ghiJKL0987654321',
    'home-server.internal',
    'ABC123',
  ];

  it('scrubs addresses, secrets and URLs from text', () => {
    const scrub = makeScrubber([{ find: 'Fermenter Alpha', label: 'pill 1' }], 'my-pi');
    const text = [
      'pill Fermenter Alpha (08:B6:1F:00:00:66) at /org/bluez/hci0/dev_08_B6_1F_00_00_66',
      'connect ECONNREFUSED 192.168.1.50:1883 and [2001:db8::50]:8080 from my-pi',
      'POST https://discord.com/api/webhooks/123/abcDEF1234567890ghiJKL0987654321?wait=true failed',
      `GET http://${userInfo}@home-server.internal:8123/api/webhook/x?token=sekrit-token-value`,
      `Authorization: ${bearer} from brewer@example.com, {"password":"hunter2","pin":"ABC123"}`,
      'getaddrinfo ENOTFOUND home-server.internal, then brewpi.local and rapthooker.local',
      'listening on :: and 127.0.0.1 at 12:30:45, file /home/brewer/data',
    ].join('\n');
    const out = scrub(text);
    for (const s of [...secrets, 'my-pi', '/home/brewer', 'brewpi']) expect(out).not.toContain(s);
    expect(out).toContain('pill 1');
    expect(out).toContain('https://discord.com/...');
    expect(out).toContain('http://<host>/...');
    expect(out).toContain('<lan-ip>');
    expect(out).toContain('rapthooker.local');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('12:30:45');
    expect(out).toContain('listening on ::');
  });

  it('zeroes the MAC address in version 1 RAPT payloads', () => {
    expect(maskPayload(RAPT_COMPANY_ID, '50540108b61f000066aabb')).toBe('505401000000000000aabb');
    expect(maskPayload(RAPT_COMPANY_ID, CAPTURED.metricsFalling)).toBe(CAPTURED.metricsFalling);
  });

  it('builds a bundle with nothing personal in it', () => {
    const { store, config } = setup();
    const scannerListeners: ((a: Advert) => void)[] = [];
    const scanner = {
      status: bleStatus({ error: 'device 08:B6:1F:00:00:66 went away', relays: [{ name: 'MyRelay', lastAt: 0, adverts: 4 }] }),
      on: (_e: string, fn: (a: Advert) => void) => scannerListeners.push(fn),
      off: () => undefined,
    };
    const system = new SystemService(config, store, silent, { scanner, exists: () => false });
    system.start();
    scannerListeners[0]!({
      address: '08:B6:1F:00:00:66',
      rssi: -60,
      manufacturer: new Map([[RAPT_COMPANY_ID, Buffer.from(CAPTURED.metricsFalling, 'hex')]]),
      at: Date.now(),
      mono: 0,
      cached: false,
    });
    const logs = new LogBuffer();
    const log = (o: object, msg: string) => logs.write(JSON.stringify({ level: 30, time: Date.now(), svc: 'test', ...o, msg }));
    log({ pillId: '08b61f000066', address: '08:B6:1F:00:00:66' }, 'adopted Fermenter Alpha');
    log({ url: 'http://home-server.internal/hook?token=sekrit-token-value', user: 'brewer@example.com' }, 'webhook MyHookName failed');
    log({ err: 'connect ECONNREFUSED 192.168.1.50:1883' }, 'MQTT error');
    log({ password: 'hunter2' }, 'saved');
    const pill = {
      id: '08b61f000066',
      address: '08:B6:1F:00:00:66',
      raptId: '08:B6:1F:00:00:64',
      name: 'Fermenter Alpha',
      archived: false,
      info: { firmware: null, deviceType: null, payloadVersion: 2 },
      offsets: { gravity: 0, temperature: 0 },
      model: { gravitySource: 'pill', tiltPoints: [], tiltPoly: null, velocitySource: 'pill', velocityHours: 24, smoothing: 'off' },
      live: { online: true, lastHeardAt: Date.now(), lastReadingAt: Date.now(), rssi: -60, intervalSec: 120, caught: null, latest: null },
      brew: null,
    } as unknown as Pill;
    const hook = {
      name: 'MyHookName',
      url: 'http://home-server.internal/hook?token=sekrit-token-value',
      preset: 'custom',
      enabled: true,
      method: 'POST',
      bodyFormat: 'json',
      intervalMin: 15,
      pillIds: 'all',
      batch: false,
      catchUp: false,
      skipImplausible: true,
      pausedUntil: null,
      status: {
        lastAt: 1,
        lastOk: false,
        lastHttpStatus: null,
        lastError: 'getaddrinfo ENOTFOUND home-server.internal',
        sent24h: 1,
        failed24h: 1,
      },
    };
    const s = fakeServices(
      { system, store, config },
      {
        logs,
        scanner,
        pills: { list: () => [pill], nearby: () => [] },
        webhooks: { list: () => [hook] },
        tokens: { list: () => [{ id: 'x', name: 'Secret script', scope: 'read', hint: 'abcd', createdAt: 0, lastUsedAt: null }] },
        settings: {
          hub: () => ({ name: 'RaptHooker' }),
          mqtt: () => ({ enabled: true, url: `mqtts://${userInfo}@home-server.internal:8883`, discovery: true, retain: true }),
          backups: () => ({ usb: true, s3: { enabled: false, endpoint: '' }, weeklyCsv: true }),
        },
        mqtt: { status: { state: 'error', error: 'connect ECONNREFUSED 192.168.1.50:8883', lastPublishAt: null } },
      },
    );

    const bundle = buildDiagnostics(s);
    const json = JSON.stringify(bundle);
    for (const secret of [...secrets, 'MyRelay', 'Secret script']) expect(json).not.toContain(secret);
    expect(bundle.pills[0]).toMatchObject({ pill: 'pill 1' });
    expect(bundle.adverts).toEqual([
      expect.objectContaining({
        device: 'pill 1',
        rssi: -60,
        data: [expect.objectContaining({ company: 'RAPT', hex: CAPTURED.metricsFalling })],
      }),
    ]);
    expect(bundle.logs.map((l) => l.msg)).toContain('adopted pill 1');
    expect(bundle.webhooks[0]).toMatchObject({
      webhook: 'webhook 1',
      preset: 'custom',
      status: { lastError: 'getaddrinfo ENOTFOUND <host>' },
    });
    expect(bundle.status.mqtt).toMatchObject({ scheme: 'mqtts', state: 'error' });
    expect(bundle.ble.relays).toEqual([expect.objectContaining({ relay: 'relay 1', adverts: 4 })]);
    system.stop();
  });
});

describe('system routes', () => {
  async function routes(deps: SystemDeps = {}) {
    const { system, store, config } = setup(deps);
    const logs = new LogBuffer();
    for (const [level, msg] of [
      [30, 'started'],
      [40, 'slow'],
      [50, 'broken'],
    ] as const) {
      logs.write(JSON.stringify({ level, time: Date.now(), msg }));
    }
    const app = Fastify();
    const isOwner = (req: FastifyRequest) => req.headers['x-owner'] === '1';
    const ctx = {
      app,
      s: fakeServices({ system, store, config }, { logs }),
      isOwner,
      owner: {
        preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
          if (!isOwner(req)) return reply.code(403).send({ error: 'owner only' });
        },
      },
      broadcast: () => undefined,
    } as unknown as RouteContext;
    systemRoutes(ctx);
    await app.ready();
    const prev = cleanup;
    cleanup = () => {
      void app.close();
      prev?.();
    };
    return app;
  }
  const asOwner = { 'x-owner': '1' };

  beforeEach(() => vi.useRealTimers());

  it('restarts through the callback, for the owner only', async () => {
    const restart = vi.fn();
    const app = await routes({ restart });
    expect((await app.inject({ method: 'POST', url: '/api/system/restart' })).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/api/system/restart', headers: asOwner });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ restarting: true });
    expect(restart).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 650));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("says when the hub can't restart itself", async () => {
    const app = await routes();
    expect((await app.inject({ method: 'POST', url: '/api/system/restart', headers: asOwner })).statusCode).toBe(503);
  });

  it('shows the owner the logs, filtered by level', async () => {
    const app = await routes();
    expect((await app.inject({ url: '/api/system/logs' })).statusCode).toBe(403);
    const warn = (await app.inject({ url: '/api/system/logs?level=warn', headers: asOwner })).json() as LogEntry[];
    expect(warn.map((e) => e.msg)).toEqual(['slow', 'broken']);
    const last = (await app.inject({ url: '/api/system/logs?level=info&limit=1', headers: asOwner })).json() as LogEntry[];
    expect(last.map((e) => e.msg)).toEqual(['broken']);
  });

  it('gives addresses with QR codes, and the Tailscale name only to the owner', async () => {
    const { exec } = fakeExec({
      'tailscale status --json': JSON.stringify({ Self: { DNSName: 'rapthooker.example.ts.net.' } }),
      'tailscale serve status --json': JSON.stringify({ Web: { 'rapthooker.example.ts.net:443': {} } }),
    });
    const app = await routes({
      exec,
      interfaces: () => ({ eth0: [{ address: '192.168.1.50', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }] }),
      hostname: () => 'rapthooker',
    });
    const viewer = (await app.inject({ url: '/api/system/addresses' })).json() as { kind: string; url: string; qrSvg: string }[];
    expect(viewer.map((a) => a.kind)).toEqual(['lan', 'mdns']);
    expect(viewer[0]!.qrSvg).toMatch(/^<svg/);
    const owner = (await app.inject({ url: '/api/system/addresses', headers: asOwner })).json() as { kind: string; url: string }[];
    expect(owner.at(-1)).toMatchObject({ kind: 'tailscale', url: 'https://rapthooker.example.ts.net' });
  });

  it('downloads the diagnostics bundle for the owner', async () => {
    const app = await routes();
    expect((await app.inject({ url: '/api/system/diagnostics' })).statusCode).toBe(403);
    const res = await app.inject({ url: '/api/system/diagnostics', headers: asOwner });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="rapthooker-diagnostics-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.json()).toMatchObject({ app: 'rapthooker', kind: 'diagnostics', logs: expect.any(Array) });
  });
});
