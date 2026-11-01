import { ensurePill, expect, SIMULATED, test } from './helpers';

// The hub runs with pretend Wi-Fi and a pretend "Smart weather clock" on its stock firmware (screens.wifi: mock).
test('a new screen is set up from its hotspot, then shows the pill it is given', async ({ page, request }) => {
  test.setTimeout(120_000);
  const pill = await ensurePill(request, SIMULATED.water, 'Water test');
  await page.goto('/#/screens');
  await page.getByRole('button', { name: 'Add a screen' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a screen' });
  const hotspot = dialog.getByRole('listitem').filter({ hasText: 'Smart weather clock' });
  await hotspot.getByRole('button', { name: 'Set up' }).click();

  await expect(dialog.getByRole('combobox', { name: 'Wi-Fi for the screen' })).toHaveValue('Brewery');
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Kitchen');
  await dialog.getByRole('button', { name: 'Set it up' }).click();
  await expect(dialog).toBeHidden();

  // Installing the firmware, joining the network and finding the screen again takes the simulator a little while.
  await expect(page.getByRole('heading', { name: 'Kitchen is set up' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Kitchen' }) });
  await expect(card.getByText('Online')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('img', { name: 'What Kitchen shows' })).toBeVisible();

  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Kitchen' });
  await editor.getByRole('combobox', { name: 'It shows' }).selectOption({ label: 'Water test' });
  await editor.getByRole('button', { name: 'Big numbers' }).click();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();
  await expect(card.getByText(/Water test · every 1 min/)).toBeVisible();

  // The pill's page says which screen shows it.
  await page.goto(`/#/pill/${pill.id}`);
  await page.getByRole('button', { name: 'Kitchen', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Kitchen' })).toBeVisible();
});
