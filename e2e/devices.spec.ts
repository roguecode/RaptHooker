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

// The hubs' pretend Bluetooth has a red Tilt (F0:0D:5E:ED:00:20) and a Laser Level (F0:0D:5E:ED:00:30) too.
test('a RAPT Laser Level and a Tilt heard nearby are added from their tabs, marked experimental', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a device' });
  await dialog.getByRole('tab', { name: /RAPT Laser Level/ }).click();
  await expect(dialog.locator('.chip', { hasText: 'Experimental' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Found a RAPT Laser Level nearby' })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Add Laser Level' }).click();
  await expect(page).toHaveURL(/#\/pill\/f00d5eed0030$/);
  await expect(page.locator('.hero').getByText('In the keg')).toBeVisible();
  await expect(page.locator('.hero').getByText('of 19 L')).toBeVisible();

  // Kegging a beer up: the chart starts from it, and the volume can be shown in pints.
  await page.getByRole('button', { name: 'Keg up' }).click();
  const kegUp = page.getByRole('dialog', { name: 'Keg up' });
  await kegUp.getByLabel('Name').fill('E2E pale');
  await kegUp.getByLabel('ABV (%)').fill('4.8');
  await kegUp.getByRole('button', { name: 'Keg up' }).click();
  await expect(page.getByRole('button', { name: 'E2E pale', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Since it was kegged' })).toHaveAttribute('aria-pressed', 'true');
  // On a phone the units are in the display menu rather than the top bar.
  if (test.info().project.name === 'phone') await page.getByRole('button', { name: 'Display options' }).click();
  await page.getByRole('combobox', { name: 'Volume unit' }).filter({ visible: true }).selectOption('pint-uk');
  await expect(page.locator('.hero').getByText('of 33 pints')).toBeVisible();
  await page.goto('/#/');
  const card = page.locator('article.pill-card').filter({ hasText: 'E2E pale' });
  await expect(card.getByText('On tap')).toBeVisible();
  await expect(card.getByText('4.8% ABV')).toBeVisible();

  await page.goto('/#/');
  await page.getByRole('button', { name: 'Add device' }).first().click();
  await dialog.getByRole('tab', { name: /Tilt/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Found Tilt Red nearby' })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Add Tilt' }).click();
  await expect(page).toHaveURL(/#\/pill\/f00d5eed0020$/);
  await expect(page.getByRole('heading', { name: 'Tilt Red', level: 1 })).toBeVisible();
});
