import { ensurePill, expect, SIMULATED, test } from './helpers';

const naturalWidth = (img: HTMLImageElement) => img.naturalWidth;

test('an image link gives a small screen a picture of a pill, or of them all', async ({ page, request }) => {
  const pill = await ensurePill(request, SIMULATED.water, 'Water test');
  await page.goto(`/#/pill/${pill.id}`);
  await page.getByRole('button', { name: 'Image link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Image link for Water test' });
  const preview = dialog.getByRole('img', { name: 'Preview of the picture' });
  // The preview is the hub's own picture, here for a GeekMagic screen.
  await expect.poll(() => preview.evaluate(naturalWidth)).toBe(240);

  const url = new URL(await dialog.getByLabel('Link for the screen').inputValue());
  expect(url.pathname).toBe(`/api/pills/${pill.id}/image.jpg`);
  expect(url.searchParams.get('w')).toBe('240');
  // What a screen fetching the link gets: a JPEG, fresh every time.
  const res = await request.get(`${url.pathname}${url.search}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/jpeg');
  expect(res.headers()['cache-control']).toBe('no-store');
  expect([...(await res.body()).subarray(0, 2)]).toEqual([0xff, 0xd8]);

  await dialog.getByRole('combobox', { name: 'Screen size' }).selectOption('lcd-800');
  await expect.poll(() => preview.evaluate(naturalWidth)).toBe(800);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  await page.goto('/');
  await page.getByRole('button', { name: 'Image link' }).click();
  const all = page.getByRole('dialog', { name: 'Image link for all pills' });
  // The screen picked last time is remembered.
  await expect.poll(() => all.getByRole('img', { name: 'Preview of the picture' }).evaluate(naturalWidth)).toBe(800);
  expect(new URL(await all.getByLabel('Link for the screen').inputValue()).pathname).toBe('/api/image.jpg');
});
