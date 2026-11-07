import type { Brew } from '@rapthooker/shared';
import { ensurePill, expect, SIMULATED, test } from './helpers';

const HOUR = 3_600_000;

/** A time as an <input type="datetime-local"> takes it (the browser runs in this computer's time zone). */
const local = (ts: number) => new Date(ts - new Date(ts).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

test("a brew's event lasts a while, and is taken off the chart and put back", async ({ page, request }) => {
  // Not the ale: the dashboard's test finds it nearby and adds it.
  const pill = await ensurePill(request, SIMULATED.lager, 'Czech Pils');
  // A retry starts with no brew running on the pill.
  const running = ((await (await request.get(`/api/brews?pill=${pill.id}`)).json()) as Brew[]).filter((b) => b.endedAt === null);
  for (const b of running) await request.post(`/api/brews/${b.id}/end`, { data: {} });
  const now = Date.now();
  const started = await request.post('/api/brews', { data: { pillId: pill.id, name: 'Event test', startedAt: now - 48 * HOUR } });
  expect(started.ok()).toBe(true);
  const brew = (await started.json()) as Brew;

  try {
    await page.goto(`/#/brew/${brew.id}`);
    await page.getByRole('button', { name: 'Add event' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add an event' });
    await dialog.getByLabel('When').fill(local(now - 36 * HOUR));
    await dialog.getByRole('textbox', { name: 'Details (optional)' }).fill('100 g Citra');
    await dialog.getByRole('button', { name: 'Add an end time' }).click();
    await dialog.getByLabel('Until').fill(local(now - 12 * HOUR));
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const timeline = page.locator('.brew-timeline li').filter({ hasText: '100 g Citra' });
    await expect(timeline).toContainText('Day 1');
    await expect(timeline).toContainText('→');
    await expect(timeline).toContainText('(1.0 days)');
    const saved = async () => ((await (await request.get(`/api/brews/${brew.id}`)).json()) as Brew).events[0]!;
    const event = await saved();
    expect(event.endAt! - event.at).toBe(24 * HOUR);
    expect(event.hidden).toBe(false);

    await timeline.getByRole('button', { name: 'Hide dry hop from the chart' }).click();
    await expect(timeline).toContainText('Not on the chart');
    expect(await saved()).toMatchObject({ endAt: event.endAt, hidden: true });

    await timeline.getByRole('button', { name: 'Show dry hop on the chart' }).click();
    await expect(timeline).not.toContainText('Not on the chart');
    expect(await saved()).toMatchObject({ endAt: event.endAt, hidden: false });
  } finally {
    // The pill page's test starts a brew on this pill.
    await request.post(`/api/brews/${brew.id}/end`, { data: {} });
  }
});
