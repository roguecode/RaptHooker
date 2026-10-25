import { ensurePill, expect, SIMULATED, test } from './helpers';

test('TV mode shows the pills in big type', async ({ page, request }) => {
  await ensurePill(request, SIMULATED.water, 'Water test');
  await page.goto('/#/kiosk');
  await expect(page.locator('.kiosk-clock')).toHaveText(/\d/);
  const water = page.getByRole('article', { name: 'Water test' });
  // Smaller screens show fewer pills at a time: move on until it's on screen.
  await expect(async () => {
    if (!(await water.isVisible())) await page.keyboard.press('ArrowRight');
    await expect(water).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await expect(water.locator('.kt-gravity')).toHaveText(/^\d\.\d{4}SG$/);

  await page.getByRole('button', { name: 'Exit TV mode' }).click();
  await expect(page.getByRole('heading', { name: 'Your pills' })).toBeVisible();
});
