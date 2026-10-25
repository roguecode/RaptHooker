import { expect, RAPT_ID, test } from './helpers';

test('a simulated pill turns up nearby, gets added and shows its readings', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your pills' })).toBeVisible();
  await expect(page.getByText('Simulated pills')).toBeVisible();

  const found = page.getByRole('region', { name: 'Pills nearby' }).locator('.nearby').filter({ hasText: RAPT_ID.ale });
  await expect(found).toBeVisible({ timeout: 30_000 });
  await found.getByRole('textbox').fill('Hazy IPA');
  await found.getByRole('button', { name: 'Add pill' }).click();

  // Adding a pill opens its page.
  await expect(page).toHaveURL(/#\/pill\//);
  await expect(page.getByRole('heading', { level: 1, name: 'Hazy IPA' })).toBeVisible();

  await page.getByRole('link', { name: 'All pills' }).click();
  const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: 'Hazy IPA', exact: true }) });
  await expect(card).toBeVisible();
  await expect(card.locator('.gravity-value')).toHaveText(/^1\.0\d{3}SG$/);
  await expect(card.locator('.temp-value')).toHaveText(/^\d+\.\d °C$/);
  await expect(page.getByRole('region', { name: 'Pills nearby' }).locator('.nearby').filter({ hasText: RAPT_ID.ale })).toHaveCount(0);
});
