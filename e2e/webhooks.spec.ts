import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './helpers';

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A stand-in for Discord on this computer: it answers like Discord does (204, no content). */
async function startReceiver() {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { received, url: `http://127.0.0.1:${port}/api/webhooks/123/e2e-token`, close: () => new Promise((r) => server.close(r)) };
}

test('a Discord webhook sends a test to a receiver on this computer', async ({ page }) => {
  const receiver = await startReceiver();
  try {
    await page.goto('/#/webhooks');
    await page.getByRole('button', { name: /Discord/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New Discord webhook' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Brew channel');
    await page.getByRole('textbox', { name: 'URL', exact: true }).fill(receiver.url);
    await page.getByRole('button', { name: 'Create webhook' }).click();

    // Once created, the editor shows the saved webhook and its delivery log.
    await expect(page.getByRole('heading', { level: 1, name: 'Edit webhook' })).toBeVisible();
    const log = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Recent deliveries' }) });
    await expect(log).toBeVisible();

    await page.getByRole('button', { name: 'Send a test now' }).click();
    const preview = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Preview' }) });
    await expect(preview.locator('.delivery').filter({ hasText: 'test' }).locator('.chip.success')).toHaveText('204');

    await expect(async () => {
      await log.getByRole('button', { name: 'Refresh' }).click();
      await expect(log.locator('.delivery').filter({ hasText: 'test' }).locator('.chip.success').first()).toHaveText('204', {
        timeout: 1000,
      });
    }).toPass({ timeout: 15_000 });

    expect(receiver.received.length).toBeGreaterThan(0);
    const sent = receiver.received[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/api/webhooks/123/e2e-token');
    expect(sent.headers['content-type']).toMatch(/^application\/json/);
    const body = JSON.parse(sent.body) as { username: string; content: string };
    expect(body.username).toBe('RaptHooker');
    expect(body.content).toMatch(/°C, battery \d+(\.\d)?%$/);
  } finally {
    await receiver.close();
  }
});
