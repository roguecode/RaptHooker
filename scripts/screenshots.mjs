/**
 * The screenshots in docs/images: a hub with the simulated pills and a few days of seeded history, photographed with
 * Playwright. Run `npm run build` first (and `npx playwright install chromium` once), then:
 *
 *   node scripts/screenshots.mjs
 */
/* global document -- used in the functions that run in the browser */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const SERVER = join('src', 'server', 'dist', 'rapthooker.cjs');
if (!existsSync(SERVER) || !existsSync(join('src', 'web', 'dist', 'index.html'))) {
  throw new Error('The screenshots use the built app: run `npm run build` first.');
}
const OUT = resolve('docs', 'images');
const PORT = Number(process.env.RAPTHOOKER_SHOTS_PORT ?? 18090);
const BASE = `http://127.0.0.1:${PORT}`;

const dir = mkdtempSync(join(tmpdir(), 'rapthooker-shots-'));
const dataDir = join(dir, 'data');
mkdirSync(dataDir);
const config = join(dir, 'rapthooker.config.json');
writeFileSync(
  config,
  JSON.stringify({
    webDir: resolve('src', 'web', 'dist'),
    bluetooth: { mock: true },
    auth: { trustLocalhost: true },
    clock: { maxSyncWaitMin: 0 },
  }),
);
const env = { ...process.env, RAPTHOOKER_CONFIG: config, RAPTHOOKER_PORT: String(PORT), RAPTHOOKER_DATA_DIR: dataDir };

execSync('npm run seed -w src/server', { env, stdio: 'inherit' });
const hub = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'ignore', 'inherit'] });

async function hubReady() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/session`)).ok) return;
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('The hub did not start');
}

/** Waits until every card (the three pills and the thermometer) has heard its device and drawn its chart. */
async function pillsLive(page, count = 4) {
  await page.waitForFunction(
    (n) => {
      const cards = [...document.querySelectorAll('article.pill-card')];
      return (
        cards.length === n &&
        cards.every((c) => c.querySelector('svg.sparkline path') && c.querySelector('.signal-quality')?.textContent !== '–')
      );
    },
    count,
    { timeout: 30_000 },
  );
}

const shots = [];
async function shoot(name, viewport, path, { fullPage = false, mobile = false, ready, settleMs = 1500 } = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'en-US',
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/${path}`);
  if (ready) await ready(page);
  // Fonts, charts and the entrance animations. (The mouse isn't moved: TV mode would show its controls.)
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  shots.push(name);
  await context.close();
}

/** Checks the phone's first card clears the bottom navigation, so the README shows all of it. */
async function firstCardInView(page) {
  await pillsLive(page);
  const gap = await page.evaluate(
    () =>
      document.querySelector('.nav').getBoundingClientRect().top -
      document.querySelector('article.pill-card').getBoundingClientRect().bottom,
  );
  if (gap < 0) console.warn(`The phone's first card is ${-gap}px behind the bottom navigation: try a taller phone.`);
}

let browser;
try {
  await hubReady();
  // An owner PIN, as on a set-up hub (otherwise the first-run guide and a PIN reminder fill the pages).
  const pin = await fetch(`${BASE}/api/owner-pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'screenshots' }),
  });
  if (!pin.ok) throw new Error(`Couldn't set the owner PIN: ${pin.status} ${await pin.text()}`);
  browser = await chromium.launch();
  // The lager is mid-fermentation in the simulation, so its page has predictions to show.
  const lager = (await (await fetch(`${BASE}/api/pills`)).json()).find((p) => p.name === 'Czech Pils');

  await shoot('dashboard', { width: 1280, height: 860 }, '', { fullPage: true, ready: (p) => pillsLive(p) });
  await shoot('pill', { width: 1280, height: 900 }, `#/pill/${lager.id}`, {
    fullPage: true,
    ready: async (p) => {
      await p.getByRole('button', { name: 'Data', exact: true }).click();
      await p.locator('section.pill-tiles .signal-bars').waitFor();
    },
  });
  await shoot('webhooks', { width: 1280, height: 900 }, '#/webhooks', {
    fullPage: true,
    ready: (p) => p.getByText('Create UNLIMITED FREE webhooks').waitFor(),
  });
  await shoot('webhook-editor', { width: 1280, height: 900 }, '#/webhooks/new?preset=brewfather', {
    fullPage: true,
    ready: (p) => p.locator('textarea').first().waitFor(),
  });
  // A Pixel 8 Pro's screen: tall enough for the whole first card.
  await shoot('mobile', { width: 448, height: 998 }, '', { mobile: true, ready: firstCardInView });
  // TV mode shows its controls for a few seconds after opening.
  await shoot('kiosk', { width: 1280, height: 720 }, '#/kiosk', {
    ready: (p) => p.locator('svg.sparkline path').nth(3).waitFor(),
    settleMs: 5500,
  });
  console.log(`Saved ${shots.map((s) => `${s}.png`).join(', ')} to ${OUT}`);
} finally {
  await browser?.close();
  hub.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
