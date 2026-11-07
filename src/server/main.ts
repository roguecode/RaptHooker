import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import pino from 'pino';
import type { HubSettings } from '@rapthooker/shared';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { ClockGuard } from './clock.js';
import { PillService } from './pills.js';
import { BrewService } from './brews.js';
import { KegService } from './kegs.js';
import { WebhookService } from './webhooks.js';
import { AlertService } from './alerts.js';
import { PushService, loadVapidKeys } from './push.js';
import { Maintenance } from './maintenance.js';
import { applyPendingRestore } from './restore.js';
import { keepPreUpdateCopy } from './backup/files.js';
import { buildServer } from './server.js';
import { Settings } from './settings.js';
import { MqttService } from './mqtt.js';
import { ChannelService } from './channels.js';
import { UpdateService } from './updates.js';
import { SystemService } from './system.js';
import { TokenService } from './tokens.js';
import { LogBuffer } from './logbuffer.js';
import { BluezScanner } from './ble/bluez.js';
import { MockScanner } from './ble/mock.js';
import { OffScanner, UnavailableScanner, type Scanner } from './ble/scanner.js';
import { CompositeScanner } from './ble/composite.js';
import { RelayHub } from './ble/relays.js';
import { createScreens } from './screens/index.js';
import { FakeScreen } from './screens/simulator.js';
import { IspindelService } from './ispindel/service.js';
import { FakeIspindel } from './ispindel/simulator.js';

declare const __RAPTHOOKER_VERSION__: string | undefined;
declare const __RAPTHOOKER_BUILD__: { commit: string | null; changes: boolean; builtAt: number } | undefined;
const VERSION = typeof __RAPTHOOKER_VERSION__ === 'string' ? __RAPTHOOKER_VERSION__ : '0.3.0-dev';
const BUILD = typeof __RAPTHOOKER_BUILD__ === 'object' ? __RAPTHOOKER_BUILD__ : undefined;

// node:sqlite still prints an experimental warning on some Node versions; it's expected.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/i.test(text)) return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

async function main(): Promise<void> {
  const logs = new LogBuffer();
  const log = pino(
    { level: process.env.LOG_LEVEL ?? 'info' },
    // Each stream passes everything the logger lets through (a stream without a level only takes info and up).
    pino.multistream([
      { level: 'trace', stream: process.stdout },
      { level: 'trace', stream: { write: (line: string) => logs.write(line) } },
    ]),
  );
  // One misbehaving part must not stop the recording.
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason instanceof Error ? reason.stack : String(reason) }, 'unhandled promise rejection');
  });

  // Built: <root>/server/rapthooker.cjs with the app in <root>/web/dist. Development: src/server and src/web/dist.
  const here = dirname(resolve(process.argv[1] ?? '.'));
  const { config, path: configPath } = loadConfig(resolve(here, '..', 'web', 'dist'));
  if (!configPath) log.warn('No rapthooker.config.json: development mode with simulated pills');
  mkdirSync(config.dataDir, { recursive: true });

  applyPendingRestore(config.dataDir, log.child({ svc: 'restore' }));
  // An update that changes how the data is stored keeps a copy of it from before (listed with the backups).
  const store = new Store(join(config.dataDir, 'rapthooker.db'), {
    beforeUpgrade: (copyTo, from, to) => {
      const copy = keepPreUpdateCopy(config.dataDir, copyTo);
      log.warn({ from, to, copy }, 'upgrading the database; a copy of it from before is kept');
      return copy;
    },
  });
  const clock = ClockGuard.forPlatform(config.clock.maxSyncWaitMin * 60_000);
  if (!clock.trusted) log.warn("the clock hasn't been synced yet: readings are held until it is");
  const settings = new Settings(store);
  const pills = new PillService(store, clock, log.child({ svc: 'pills' }), Date.now, { holdMs: 2500 });
  const brews = new BrewService(store, pills, log.child({ svc: 'brews' }));
  brews.abvFormula = () => settings.hub().abvFormula;
  pills.brewOf = (id) => brews.activeFor(id);
  const kegs = new KegService(store, pills, log.child({ svc: 'kegs' }));
  pills.load();
  brews.load();
  const webhooks = new WebhookService(
    store,
    { pills, brews, clockTrusted: () => clock.trusted, version: VERSION, hubName: () => settings.hub().name },
    log.child({ svc: 'webhooks' }),
  );
  webhooks.load();
  const push = new PushService(store, loadVapidKeys(config.dataDir), config.push.subject, log.child({ svc: 'push' }));
  const channels = new ChannelService(store, log.child({ svc: 'channels' }));
  channels.load();
  const alerts = new AlertService(
    store,
    { pills, brews, units: () => settings.units(), clockTrusted: () => clock.trusted },
    push,
    log.child({ svc: 'alerts' }),
    channels,
  );
  alerts.load();
  const maintenance = new Maintenance(store, log.child({ svc: 'maintenance' }), {
    backupDir: config.backup.dir,
    backupTime: config.backup.time,
    keep: config.backup.keep,
    rawRetentionDays: config.rawRetentionDays,
    dataDir: config.dataDir,
    settings,
    pills,
    brews,
  });
  const mqtt = new MqttService({ pills, brews, settings, version: VERSION }, log.child({ svc: 'mqtt' }));
  const updates = new UpdateService(VERSION, settings, log.child({ svc: 'updates' }), {
    dataDir: config.dataDir,
    store,
    build: BUILD,
    // Without the build's stamp, this is the dev server running the source.
    fromSource: BUILD === undefined,
  });
  const tokens = new TokenService(store);

  const bt = config.bluetooth;
  // The hub's own Bluetooth, made afresh each time it's switched on in Settings.
  const makeRadio = (): Scanner => {
    if (!bt.enabled) return new OffScanner('config');
    if (!settings.hub().bluetooth) return new OffScanner('settings');
    if (bt.mock) return new MockScanner();
    if (process.platform !== 'linux') {
      return new UnavailableScanner('Bluetooth needs Linux with BlueZ (or set bluetooth.mock in the config to simulate pills)');
    }
    return new BluezScanner(log.child({ svc: 'ble' }), {
      adapters: bt.adapters,
      adapter: bt.adapter,
      scanMode: bt.scanMode,
      // Pills being recorded that the hub's own Bluetooth should hear: heard in the last day, and not only by relays.
      expectPills: () =>
        scanner.radioExpects(
          pills
            .list()
            .filter((p) => !p.archived)
            .map((p) => ({ address: p.address, lastHeardAt: p.live.lastHeardAt })),
        ),
      dataDir: config.dataDir,
    });
  };
  // Relays (an ESP32 posting what it hears to /api/relay) feed the same stream as the hub's own Bluetooth.
  const scanner = new CompositeScanner(makeRadio(), new RelayHub(log.child({ svc: 'relays' })));
  // shutdown is defined below; restart is only ever called once the hub is running.
  const system = new SystemService(config, store, log.child({ svc: 'system' }), {
    scanner,
    clock,
    maintenance,
    restart: () => void shutdown('restart'),
  });
  // iSpindels' set-up shares the screens' Wi-Fi control (one thing on a hotspot at a time).
  const fakeIspindels: FakeIspindel[] = [];
  let ispindelBusy = (): boolean => false;
  const { screens, fakes, wifi } = createScreens({
    config,
    store,
    settings,
    system,
    log: log.child({ svc: 'screens' }),
    hotspots: () => fakeIspindels,
    wifiBusy: () => ispindelBusy(),
  });
  screens.load();
  if (config.screens.wifi === 'mock') {
    // A pretend "Smart weather clock" on its stock firmware, ready to be set up.
    const fake = new FakeScreen({ networks: { Brewery: 'hops-and-barley' } });
    await fake.start();
    fakes.push(fake);
    // A pretend iSpindel in setup mode, ready to be set up from Add device; it then sends a reading a minute.
    const spindel = new FakeIspindel({ networks: { Brewery: 'hops-and-barley' }, postEveryMs: 60_000 });
    await spindel.start();
    fakeIspindels.push(spindel);
  }
  const { hubUrl } = config.screens;
  const ispindel = new IspindelService({
    store,
    tokens,
    pills,
    wifi,
    addresses: hubUrl ? async () => [{ kind: 'lan', url: hubUrl }] : () => system.addresses({ tailscale: false }),
    screensBusy: () => screens.busy(),
    log: log.child({ svc: 'ispindel' }),
  });
  ispindelBusy = () => ispindel.busy();

  const guarded = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log.error({ err: (err as Error).stack ?? String(err) }, `${what} failed`);
    }
  };
  scanner.on('advert', (advert) => guarded('handling an advert', () => pills.handleAdvert(advert)));
  pills.on('reading', (pillId: string, reading) => {
    guarded('updating the brew', () => brews.onReading(pillId, reading));
    guarded('checking alerts', () => alerts.evaluatePill(pillId));
    guarded('publishing to MQTT', () => mqtt.onReading(pillId, reading));
    void webhooks.tick();
  });
  pills.on('offsets', (pillId: string) => guarded('refreshing the brew', () => brews.refresh(pillId)));
  settings.on('hub', () => guarded('updating brew ABV', () => brews.refreshAbv()));
  // Switching Bluetooth on or off in Settings takes effect straight away (a config file that switches it off wins).
  let radioOn = settings.hub().bluetooth;
  settings.on('hub', (hub: HubSettings) => {
    if (!bt.enabled || hub.bluetooth === radioOn) return;
    radioOn = hub.bluetooth;
    log.info(radioOn ? 'bluetooth switched on in Settings' : 'bluetooth switched off in Settings');
    scanner.setRadio(makeRadio()).catch((err: Error) => log.error({ err: err.message }, 'bluetooth failed to start'));
  });
  pills.on('removed', (pillId: string) => brews.forgetPill(pillId));
  clock.on('trusted', ({ synced }: { synced: boolean }) => {
    log.info({ synced }, synced ? 'clock synced' : 'gave up waiting for the clock to sync; using it as it is');
    void webhooks.tick();
  });

  const app = await buildServer(
    {
      config,
      store,
      pills,
      brews,
      webhooks,
      alerts,
      push,
      maintenance,
      scanner,
      clock,
      settings,
      mqtt,
      channels,
      updates,
      system,
      tokens,
      screens,
      ispindel,
      kegs,
      logs,
      version: VERSION,
      startedAt: Date.now(),
    },
    { logger: log },
  );

  clock.start();
  pills.start();
  webhooks.start();
  alerts.start();
  maintenance.start();
  updates.start();
  system.start();
  screens.start();
  ispindel.start();
  void mqtt.start().catch((err: Error) => log.error({ err: err.message }, 'MQTT failed to start'));
  await scanner.start().catch((err: Error) => log.error({ err: err.message }, 'bluetooth failed to start'));
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    // A machine without IPv6 can't listen on `::`; IPv4 alone will do.
    const code = (err as NodeJS.ErrnoException).code;
    if (config.host !== '::' || (code !== 'EAFNOSUPPORT' && code !== 'EADDRNOTAVAIL')) throw err;
    await app.listen({ host: '0.0.0.0', port: config.port });
  }
  log.info(
    {
      version: VERSION,
      config: configPath ?? '(development defaults)',
      dataDir: config.dataDir,
      pills: pills.list().length,
      ble: scanner.status.state,
    },
    'RaptHooker started',
  );
  system.ready();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    clock.stop();
    pills.stop();
    alerts.stop();
    updates.stop();
    system.stop();
    screens.stop();
    ispindel.stop();
    for (const fake of fakes) await fake.stop();
    for (const fake of fakeIspindels) await fake.stop();
    await webhooks.stop();
    await mqtt.stop().catch(() => undefined);
    await scanner.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    await maintenance.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
