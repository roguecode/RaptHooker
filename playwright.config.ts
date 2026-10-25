import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the built app (`npm run build` first). Each project gets its own hub: the built server
 * with simulated pills, a fresh data folder in the system temp folder, and this computer trusted as the owner.
 */
const SERVER = join('src', 'server', 'dist', 'rapthooker.cjs');
if (!existsSync(SERVER) || !existsSync(join('src', 'web', 'dist', 'index.html'))) {
  throw new Error('The end-to-end tests use the built app: run `npm run build` first.');
}

const BASE_PORT = Number(process.env.RAPTHOOKER_E2E_PORT ?? 18080);
// One folder per run, shared with the test workers (they inherit the environment). e2e/global-setup.ts tidies up
// the folders of earlier runs.
process.env.RAPTHOOKER_E2E_DIR ||= mkdtempSync(join(tmpdir(), 'rapthooker-e2e-'));
const RUN_DIR = process.env.RAPTHOOKER_E2E_DIR;

// The development defaults (simulated pills, localhost is the owner), but without waiting for the clock to be set
// from the network, which a CI machine might not report.
const CONFIG = join(RUN_DIR, 'rapthooker.config.json');
if (!existsSync(CONFIG)) {
  writeFileSync(
    CONFIG,
    JSON.stringify({
      webDir: resolve('src', 'web', 'dist'),
      bluetooth: { mock: true },
      auth: { trustLocalhost: true },
      clock: { maxSyncWaitMin: 0 },
    }),
  );
}

const HUBS = [
  { name: 'desktop', device: devices['Desktop Chrome'], port: BASE_PORT },
  { name: 'phone', device: devices['Pixel 7'], port: BASE_PORT + 1 },
];

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  outputDir: 'test-results',
  // A project's tests share its hub, so they run one at a time; the two projects run side by side.
  fullyParallel: false,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: HUBS.map((hub) => ({
    name: hub.name,
    workers: 1,
    use: { ...hub.device, baseURL: `http://127.0.0.1:${hub.port}` },
  })),
  webServer: HUBS.map((hub) => {
    const dataDir = join(RUN_DIR, hub.name);
    mkdirSync(dataDir, { recursive: true });
    return {
      command: `node ${SERVER}`,
      url: `http://127.0.0.1:${hub.port}/api/session`,
      env: { RAPTHOOKER_CONFIG: CONFIG, RAPTHOOKER_PORT: String(hub.port), RAPTHOOKER_DATA_DIR: dataDir },
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    };
  }),
});
