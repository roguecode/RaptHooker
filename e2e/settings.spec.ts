import { expect, test } from './helpers';

test('the hub gets a name, and this browser a theme and a language', async ({ page }) => {
  // A new name each time: a retry or repeat finds the hub with the name the last run gave it, and Save needs a change.
  const { project, repeatEachIndex, retry } = test.info();
  const name = `Brewery ${project.name} ${repeatEachIndex}.${retry}`;
  await page.goto('/#/settings');
  const hub = page.locator('section.panel').filter({ has: page.getByRole('heading', { level: 2, name: 'Hub' }) });
  await hub.getByRole('textbox', { name: 'Hub name' }).fill(name);
  await hub.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.brand-name')).toHaveText(name);
  await expect(page).toHaveTitle(new RegExp(name));

  const menu = page.getByRole('button', { name: 'Display options' });
  await menu.click();
  const options = page.getByRole('group', { name: 'Display options' });
  await options.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await options.getByRole('combobox', { name: 'Language' }).selectOption('de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');

  // Both are remembered by this browser.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});
