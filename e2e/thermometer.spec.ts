import type { AlertEvent, AlertRule } from '@rapthooker/shared';
import { ensurePill, expect, SIMULATED, test } from './helpers';

test('a RAPT Thermometer is recorded with only its temperature', async ({ page, request }) => {
  const thermometer = await ensurePill(request, SIMULATED.thermometer, 'Brew fridge');
  expect(thermometer.kind).toBe('thermometer');

  await page.goto(`/#/pill/${thermometer.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Brew fridge' })).toBeVisible();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const tiles = page.getByRole('region', { name: 'Latest values' });
  await expect(tiles.getByText('RAPT Thermometer', { exact: true })).toBeVisible();
  await expect(tiles.getByText('Gravity')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Thermometer settings' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Lines on the chart' }).getByRole('button')).toHaveText(['Temperature', 'Signal']);
  await expect(page.getByRole('group', { name: 'History of Brew fridge' }).locator('canvas').first()).toBeVisible();

  await page.goto('/#/');
  const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: 'Brew fridge', exact: true }) });
  await expect(card.getByText('Thermometer', { exact: true })).toBeVisible();
  await expect(card.locator('.gravity-value')).toContainText('°C');
});

// On the thermometer, which this file adds: no pill's chart (tested elsewhere) gets an alert's mark.
test('an alert that goes off lights up the bell until it is acknowledged', async ({ page, request }) => {
  const name = `Fridge check (${test.info().project.name})`;
  const fridge = await ensurePill(request, SIMULATED.thermometer, 'Brew fridge');
  const rule = (await (
    await request.post('/api/alerts/rules', { data: { name, kind: 'temp_above', threshold: -40, pillIds: [fridge.id] } })
  ).json()) as AlertRule;
  try {
    await expect
      .poll(async () => ((await (await request.get('/api/alerts/events?unacked=1')).json()) as AlertEvent[]).map((e) => e.ruleName))
      .toContain(name);

    await page.goto('/#/');
    const bell = page.getByRole('button', { name: /alerts? to acknowledge$/ });
    await expect(bell).toHaveClass(/alerting/);
    await bell.click();
    const item = page.locator('.alerts-pop-item').filter({ hasText: name });
    await expect(item).toContainText('Brew fridge');
    // It opens the device's page.
    await item.getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Brew fridge' })).toBeVisible();

    await bell.click();
    await page.getByRole('button', { name: `Acknowledge "${name}"` }).click();
    await expect(page.locator('.alerts-pop-item').filter({ hasText: name })).toHaveCount(0);
    const waiting = (await (await request.get('/api/alerts/events?unacked=1')).json()) as AlertEvent[];
    expect(waiting.map((e) => e.ruleName)).not.toContain(name);
  } finally {
    await request.delete(`/api/alerts/rules/${rule.id}`);
    await request.post('/api/alerts/events/ack', { data: { ids: 'all' } });
  }
});
