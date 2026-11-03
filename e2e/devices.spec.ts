import { expect, test } from './helpers';

// Each hub runs with pretend Wi-Fi (screens.wifi: mock) and a pretend iSpindel in setup mode: its open "iSpindel"
// hotspot shows up in the hub's scans, and once set up it posts readings to the hub like a real one.
test('the Add device dialog has a tab per kind, listing what is heard nearby', async ({ page }) => {
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a device' });
  // Other tests may have added the simulated devices already: then the tab is listening for more.
  await dialog.getByRole('tab', { name: /RAPT Thermometer/ }).click();
  await expect(
    dialog
      .getByRole('heading', { name: 'Found a RAPT Thermometer nearby' })
      .or(dialog.getByText('Listening for RAPT Thermometers…'))
      .first(),
  ).toBeVisible();
  await dialog.getByRole('tab', { name: /RAPT Pill/ }).click();
  await expect(dialog.getByText('Telemetry via Bluetooth', { exact: false })).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Found a RAPT Pill nearby' }).or(dialog.getByText('Listening for RAPT Pills…')).first(),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('an iSpindel in setup mode is found, set up by the hub and added with its first reading', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a device' });
  await dialog.getByRole('tab', { name: /iSpindel/ }).click();

  // It says what it will do before doing it.
  await expect(dialog.getByText('What the hub does')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /iSpindel · chip 52480A/ })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('combobox', { name: 'Wi-Fi for the iSpindel' })).toHaveValue('Brewery');
  await dialog.getByRole('textbox', { name: 'Name (optional)' }).fill('Spindel e2e');
  await dialog.getByRole('button', { name: 'Set up iSpindel' }).click();

  await expect(dialog.getByText('Spindel e2e is added')).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('link', { name: 'Open Spindel e2e' }).click();
  await expect(page).toHaveURL(/#\/pill\/ispindel-52480a$/);
  await expect(page.getByRole('heading', { name: 'Spindel e2e', level: 1 })).toBeVisible();
  await expect(page.getByText('ISPINDEL:52480A')).toBeVisible();

  // Opened again, the tab is ready to set up another rather than showing this one again.
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  await dialog.getByRole('tab', { name: /iSpindel/ }).click();
  await expect(dialog.getByText('What the hub does')).toBeVisible();
  await expect(dialog.getByText('Spindel e2e is added')).toBeHidden();
});
