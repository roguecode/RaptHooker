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
