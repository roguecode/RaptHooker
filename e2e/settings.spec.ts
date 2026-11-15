import { DEFAULT_HUB_SETTINGS, type HubSettings } from '@rapthooker/shared';
import { ensurePill, expect, SIMULATED, test } from './helpers';

test('the hub gets a name, and this browser a theme, colours and a language', async ({ page }) => {
  // A new name each time: a retry or repeat finds the hub with the name the last run gave it, and Save needs a change.
  const { project, repeatEachIndex, retry } = test.info();
  const name = `Brewery ${project.name} ${repeatEachIndex}.${retry}`;
  await page.goto('/#/settings');
  const hub = page.locator('section.panel').filter({ has: page.getByRole('heading', { level: 2, name: 'Hub' }) });
  await hub.getByRole('textbox', { name: 'Hub name' }).fill(name);
  await hub.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.brand-name')).toHaveText(name);
  await expect(page).toHaveTitle(new RegExp(name));

  // Violet unless this browser picks other colours.
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'violet');
  await hub.getByRole('group', { name: 'Colours' }).getByRole('button', { name: 'Ocean' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'ocean');

  const menu = page.getByRole('button', { name: 'Display options' });
  await menu.click();
  const options = page.getByRole('group', { name: 'Display options' });
  await options.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await options.getByRole('combobox', { name: 'Language' }).selectOption('de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');

  // All three are remembered by this browser.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'ocean');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});

test('a big screen can use its full width, with bigger charts', async ({ page, request }) => {
  test.skip(test.info().project.name === 'phone', "A phone's pages are as wide as its screen");
  const pill = await ensurePill(request, SIMULATED.water, 'Water test');
  await page.setViewportSize({ width: 2560, height: 1200 });
  await page.goto(`/#/pill/${pill.id}`);
  const main = page.locator('main');
  const chart = page.locator('.uplot canvas').first();
  await expect(chart).toBeVisible();
  // Standard unless this browser picks otherwise.
  await expect(page.locator('html')).toHaveAttribute('data-width', 'standard');
  expect((await main.boundingBox())!.width).toBeLessThan(1400);
  expect((await chart.boundingBox())!.height).toBe(360);

  await page.getByRole('button', { name: 'Display options' }).click();
  const options = page.getByRole('group', { name: 'Display options' });
  await options.getByRole('group', { name: 'Page width' }).getByRole('button', { name: 'Full' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-width', 'full');
  await expect.poll(async () => (await main.boundingBox())!.width).toBe(2560);
  await expect.poll(async () => (await chart.boundingBox())!.height).toBeGreaterThan(600);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-width', 'full');
  await expect.poll(async () => (await chart.boundingBox())?.height ?? 0).toBeGreaterThan(600);
});

test("the hub's Bluetooth is switched off and back on", async ({ page, request }) => {
  try {
    await page.goto('/#/settings');
    const hub = page.locator('section.panel').filter({ has: page.getByRole('heading', { level: 2, name: 'Hub' }) });
    const listening = page.locator('section.bt-section');
    const toggle = hub.getByRole('switch', { name: 'Listen over Bluetooth' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(listening.getByText('Simulated pills (development mode)')).toBeVisible();

    await toggle.click();
    await hub.getByRole('button', { name: 'Save' }).click();
    await expect(listening.getByText('Off: switched off in the Hub settings above')).toBeVisible();

    await page.goto('/#/');
    await expect(page.locator('.ble-chip')).toHaveText('Bluetooth off');
    await expect(page.getByText("Bluetooth isn't working.")).toHaveCount(0);

    await page.goto('/#/settings');
    await toggle.click();
    await hub.getByRole('button', { name: 'Save' }).click();
    await expect(listening.getByText('Simulated pills (development mode)')).toBeVisible();
  } finally {
    // The other tests on this hub need the simulated pills, whatever happened here.
    const hub = (await (await request.get('/api/settings/hub')).json()) as HubSettings;
    expect((await request.put('/api/settings/hub', { data: { ...hub, bluetooth: true } })).ok()).toBe(true);
  }
});

test('readings are shown with the decimals picked for the hub', async ({ page, request }) => {
  const pill = await ensurePill(request, SIMULATED.water, 'Water test');
  try {
    await page.goto('/#/settings');
    const hub = page.locator('section.panel').filter({ has: page.getByRole('heading', { level: 2, name: 'Hub' }) });
    await hub.getByRole('group', { name: 'Gravity in SG', exact: true }).getByRole('button', { name: '1.012', exact: true }).click();
    await hub.getByRole('group', { name: 'Temperature', exact: true }).getByRole('button', { name: '19.63°', exact: true }).click();
    await hub.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Hub settings saved')).toBeVisible();

    await page.goto(`/#/pill/${pill.id}`);
    await expect(page.locator('.gravity-value')).toHaveText(/^\d\.\d{3}SG$/);
    await expect(page.locator('.gravity-value .tail')).toHaveText('');
    await expect(page.locator('.temp-value')).toHaveText(/^-?\d+\.\d{2} °C$/);
  } finally {
    // The other tests on this hub expect the usual decimals.
    const hub = (await (await request.get('/api/settings/hub')).json()) as HubSettings;
    expect((await request.put('/api/settings/hub', { data: { ...hub, decimals: DEFAULT_HUB_SETTINGS.decimals } })).ok()).toBe(true);
  }
});
