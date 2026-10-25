import { test as base, expect, type APIRequestContext } from '@playwright/test';
import type { Pill } from '@rapthooker/shared';

export { RAPT_ID, SIMULATED } from './simulator';

/** Every test fails if the page throws or logs an error. */
export const test = base.extend<{ pageErrors: void }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(`Uncaught error: ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console.error at ${page.url()}: ${msg.text()}`);
      });
      await use();
      expect(errors, 'errors in the browser').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Adds a simulated pill through the API (unless it's already added) and returns it. */
export async function ensurePill(request: APIRequestContext, address: string, name: string): Promise<Pill> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pills = (await (await request.get('/api/pills')).json()) as Pill[];
    const found = pills.find((p) => p.address === address);
    if (found) return found;
    const res = await request.post('/api/pills', { data: { address, name } });
    if (res.ok()) return (await res.json()) as Pill;
    // 409: added meanwhile, so look again.
    if (res.status() !== 409) throw new Error(`Couldn't add ${address}: ${res.status()} ${await res.text()}`);
  }
  throw new Error(`Couldn't add ${address}`);
}
