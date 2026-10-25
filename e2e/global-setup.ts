import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { SIMULATED } from './simulator';

const HOUR = 3_600_000;

/** Removes the data folders of earlier runs (the servers still hold this run's, so it's left for the next run). */
function tidyEarlierRuns(current: string): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('rapthooker-e2e-') || name === basename(current)) continue;
    const dir = join(tmpdir(), name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > HOUR) rmSync(dir, { recursive: true, force: true });
    } catch {
      // In use, or already gone.
    }
  }
}

/** Checks each hub is the simulated, owner-trusting one, and waits until it has heard every simulated pill. */
async function checkHub(baseURL: string): Promise<void> {
  const session = (await (await fetch(`${baseURL}/api/session`)).json()) as { role: string };
  if (session.role !== 'owner') throw new Error(`${baseURL} doesn't treat this computer as the owner: is it a development hub?`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const state = (await (await fetch(`${baseURL}/api/state`)).json()) as { ble: { state: string }; nearby: { address: string }[] };
    if (state.ble.state !== 'mock') throw new Error(`${baseURL} isn't using simulated pills (Bluetooth state: ${state.ble.state})`);
    const heard = new Set(state.nearby.map((n) => n.address));
    if (Object.values(SIMULATED).every((a) => heard.has(a))) return;
    if (Date.now() > deadline) throw new Error(`${baseURL} hasn't heard the simulated pills`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  if (process.env.RAPTHOOKER_E2E_DIR) tidyEarlierRuns(process.env.RAPTHOOKER_E2E_DIR);
  const urls = [...new Set(config.projects.map((p) => p.use.baseURL).filter((u): u is string => Boolean(u)))];
  await Promise.all(urls.map(checkHub));
}
