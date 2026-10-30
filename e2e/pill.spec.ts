import { ensurePill, expect, SIMULATED, test } from './helpers';

test('the pill page draws its history and changes the range', async ({ page, request }) => {
  const pill = await ensurePill(request, SIMULATED.water, 'Water test');
  await page.goto(`/#/pill/${pill.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Water test' })).toBeVisible();
  const data = page.getByRole('button', { name: 'Data', exact: true });
  await expect(data).toHaveAttribute('aria-expanded', 'false');
  await data.click();
  await expect(page.getByRole('region', { name: 'Latest values' }).getByText('from the pill').first()).toBeVisible();

  const chart = page.getByRole('group', { name: 'History of Water test' });
  await expect(chart.locator('canvas').first()).toBeVisible();
  await expect(chart.getByText('No readings in this range yet')).toHaveCount(0);

  const range = page.getByRole('group', { name: 'Time range' });
  await expect(range.getByRole('button', { name: 'Last 24 hours' })).toHaveAttribute('aria-pressed', 'true');
  const reload = page.waitForResponse((r) => r.url().includes(`/api/pills/${pill.id}/history`) && r.ok());
  await range.getByRole('button', { name: 'Last 7 days' }).click();
  await reload;
  await expect(range.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(range.getByRole('button', { name: 'Last 24 hours' })).toHaveAttribute('aria-pressed', 'false');

  await range.getByRole('button', { name: 'Custom' }).click();
  const custom = page.getByRole('form', { name: 'Custom range' });
  await custom.getByLabel('From').fill('2026-01-01T08:00');
  await custom.getByLabel('To').fill('2026-01-01T07:00');
  await custom.getByRole('button', { name: 'Show' }).click();
  await expect(custom.getByRole('alert')).toHaveText('The start has to be before the end');
  await custom.getByLabel('To').fill('2026-01-02T08:00');
  await custom.getByRole('button', { name: 'Show' }).click();
  await expect(custom).toHaveCount(0);
  await expect(range.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.locator('canvas').first()).toBeVisible();
});

test('a range is left out of the chart, shown again and put back', async ({ page, request }) => {
  const pill = await ensurePill(request, SIMULATED.water, 'Water test');
  // A retry starts from a chart with nothing left out.
  for (const e of pill.exclusions ?? []) await request.delete(`/api/pills/${pill.id}/exclusions/${e.id}`);
  await page.goto(`/#/pill/${pill.id}`);
  const chart = page.getByRole('group', { name: 'History of Water test' });
  await expect(chart.locator('canvas').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exclude this range' })).toHaveCount(0);

  await chart.focus();
  await page.keyboard.press('+');
  await page.getByRole('button', { name: 'Exclude this range' }).click();
  const confirm = page.getByRole('dialog', { name: 'Exclude this range?' });
  await expect(confirm).toContainText(
    "from the graph and replace it with extrapolated data in the view. This doesn't delete the data, and you can remove this exclusion at any time.",
  );
  await confirm.getByRole('button', { name: 'Exclude range' }).click();
  await expect(confirm).toHaveCount(0);
  await page.mouse.move(0, 0);

  // Only the dashed curve shows until the range is pointed at (or tapped).
  const label = chart.getByRole('button', { name: /^Excluded range: / });
  await expect(label).toHaveCount(1);
  await expect(label).toHaveCSS('opacity', '0');
  const toggle = page.getByRole('button', { name: 'Exclusions' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(label).toHaveCount(0);
  await toggle.click();
  await page.mouse.move(0, 0);

  await chart.scrollIntoViewIfNeeded();
  const plot = (await chart.locator('.u-over').boundingBox())!;
  const box = (await label.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: plot.y + plot.height / 2 };
  if (test.info().project.name === 'phone') {
    await page.touchscreen.tap(at.x, at.y);
  } else {
    await page.mouse.move(at.x, at.y);
    await expect(label).toHaveCSS('opacity', '1');
    await page.mouse.click(at.x, at.y);
  }
  await expect(label).toHaveCSS('opacity', '1');
  await chart.getByRole('dialog', { name: 'Excluded range' }).getByRole('button', { name: 'Remove exclusion' }).click();
  await expect(label).toHaveCount(0);
  await expect(toggle).toHaveCount(0);
  const saved = (await (await request.get('/api/pills')).json()) as { id: string; exclusions: unknown[] }[];
  expect(saved.find((p) => p.id === pill.id)?.exclusions).toEqual([]);
});

test('a brew starts on a pill, shows on the Brews page and ends', async ({ page, request }) => {
  const pill = await ensurePill(request, SIMULATED.lager, 'Czech Pils');
  const name = `Pils ${test.info().project.name}`;
  await page.goto(`/#/pill/${pill.id}`);

  await page.getByRole('button', { name: 'Start a brew' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start a brew' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: 'Style', exact: true }).fill('Czech Premium Pale Lager');
  await dialog.getByRole('spinbutton', { name: /Original gravity/ }).fill('1.048');
  await dialog.getByRole('button', { name: 'Start brew' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page.getByText(/^Czech Premium Pale Lager · started /)).toBeVisible();

  await page.goto('/#/brews');
  const running = page.getByRole('link').filter({ has: page.getByRole('heading', { level: 3, name }) });
  await expect(running).toBeVisible();
  await expect(running).toContainText('Czech Pils');
  await expect(running).toContainText('Day 1');

  await page.goto(`/#/pill/${pill.id}`);
  await page.getByRole('button', { name: 'End brew' }).click();
  const confirm = page.getByRole('dialog', { name: `End "${name}"?` });
  await confirm.getByRole('button', { name: 'End brew' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start a brew' })).toBeVisible();

  await page.goto('/#/brews');
  const finished = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Finished' }) });
  await expect(finished.getByRole('heading', { level: 4, name })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name })).toHaveCount(0);
});
