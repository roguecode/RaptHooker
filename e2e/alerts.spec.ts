import type { AlertRule } from '@rapthooker/shared';
import { expect, test } from './helpers';

test('an alert rule is created', async ({ page, request }) => {
  const name = `Too warm (${test.info().project.name})`;
  await page.goto('/#/alerts');
  await page.getByRole('button', { name: 'New alert' }).click();

  const dialog = page.getByRole('dialog', { name: 'New alert' });
  await expect(dialog.getByRole('combobox')).toHaveValue('temp_above');
  await dialog.getByRole('spinbutton', { name: /^Threshold/ }).fill('23.5');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await expect(dialog.getByRole('button', { name: 'Everywhere' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Browser notifications' }).click();
  await expect(dialog.getByRole('button', { name: 'Everywhere' })).toHaveAttribute('aria-pressed', 'false');
  await expect(dialog.getByText('Alerts always show in this app too.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save alert' }).click();
  await expect(dialog).toHaveCount(0);

  const rule = page.locator('.list-item').filter({ has: page.getByRole('heading', { level: 4, name }) });
  await expect(rule).toContainText('23.5 °C');
  await expect(rule).toContainText('all pills · while brewing');
  await expect(rule).toContainText('browser notifications');

  const rules = (await (await request.get('/api/alerts/rules')).json()) as AlertRule[];
  expect(rules.find((r) => r.name === name)).toMatchObject({ kind: 'temp_above', threshold: 23.5, channelIds: ['push'], enabled: true });
});
