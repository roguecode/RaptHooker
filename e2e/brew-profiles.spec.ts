import type { Brew, BrewAlert, BrewProfile } from '@rapthooker/shared';
import { ensurePill, expect, SIMULATED, test } from './helpers';

const HOUR = 3_600_000;

/** A time as an <input type="datetime-local"> takes it (the browser runs in this computer's time zone). */
const local = (ts: number) => new Date(ts - new Date(ts).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

test("a brew's own alert and a planned event go into a profile, and the next brew starts with them", async ({ page, request }) => {
  // Not the ale: the dashboard's test finds it nearby and adds it.
  const pill = await ensurePill(request, SIMULATED.lager, 'Czech Pils');
  const endRunning = async () => {
    const brews = (await (await request.get(`/api/brews?pill=${pill.id}`)).json()) as Brew[];
    for (const b of brews.filter((x) => x.endedAt === null)) await request.post(`/api/brews/${b.id}/end`, { data: {} });
  };
  await endRunning();
  const now = Date.now();
  const first = (await (
    await request.post('/api/brews', { data: { pillId: pill.id, name: 'Profile test', startedAt: now - 48 * HOUR } })
  ).json()) as Brew;
  let profileId: string | undefined;

  try {
    await page.goto(`/#/brew/${first.id}`);
    await page.getByRole('button', { name: 'Add alert' }).click();
    const alertDialog = page.getByRole('dialog', { name: 'New alert for Profile test' });
    await expect(alertDialog.getByText(/Alerts once a brew when the gravity has dropped 0\.003/)).toBeVisible();
    await alertDialog.getByLabel('What to do (optional)').fill('Check the krausen');
    await alertDialog.getByRole('button', { name: 'Save alert' }).click();
    await expect(alertDialog).toHaveCount(0);
    const alert = page.locator('.list-item').filter({ hasText: 'Check the krausen' });
    await expect(alert).toContainText('Gravity down 3 points from the start · once a brew');

    await page.getByRole('button', { name: 'Add event' }).click();
    const eventDialog = page.getByRole('dialog', { name: 'Add an event' });
    // Well into day 4 (the box keeps the minute, not the seconds).
    await eventDialog.getByLabel('When').fill(local(now + 30 * HOUR));
    await eventDialog.getByRole('textbox', { name: 'Details (optional)' }).fill('Saaz');
    await eventDialog.getByRole('checkbox', { name: /Remind me at its start and end/ }).check();
    await eventDialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(eventDialog).toHaveCount(0);
    const planned = page.locator('.brew-timeline li').filter({ hasText: 'Saaz' });
    await expect(planned).toContainText('Day 4');
    await expect(planned).toContainText('Planned');
    await expect(planned).toContainText('Reminder');

    await page.getByRole('button', { name: 'Save as a profile' }).click();
    const saveDialog = page.getByRole('dialog', { name: 'Save as a profile' });
    await expect(saveDialog).toContainText('1 alert, 1 planned event');
    await saveDialog.getByLabel('Name').fill('Lager profile');
    await saveDialog.getByRole('button', { name: 'Save profile' }).click();
    await expect(saveDialog).toHaveCount(0);
    const profiles = (await (await request.get('/api/brew-profiles')).json()) as BrewProfile[];
    const profile = profiles.find((p) => p.name === 'Lager profile')!;
    profileId = profile.id;
    expect(profile.events).toEqual([{ offset: expect.any(Number), endOffset: null, kind: 'dry_hop', text: 'Saaz', remind: true }]);

    await endRunning();
    await page.goto('/#/brews');
    await expect(page.getByRole('heading', { name: 'Lager profile' })).toBeVisible();
    await page.getByLabel('Start a brew on').selectOption({ label: 'Czech Pils' });
    const startDialog = page.getByRole('dialog', { name: 'Start a brew' });
    await startDialog.getByLabel('Name').fill('Profile test #2');
    await startDialog.getByLabel('Profile').selectOption({ label: 'Lager profile (1 alert, 1 planned event)' });
    await expect(startDialog).toContainText('Day 4: Dry hop: Saaz');
    await startDialog.getByRole('button', { name: 'Start brew' }).click();
    await expect(startDialog).toHaveCount(0);

    const second = ((await (await request.get(`/api/brews?pill=${pill.id}`)).json()) as Brew[]).find((b) => b.endedAt === null)!;
    expect(second.name).toBe('Profile test #2');
    expect(second.events).toEqual([
      expect.objectContaining({ kind: 'dry_hop', text: 'Saaz', remind: true, at: second.startedAt + profile.events[0]!.offset }),
    ]);
    const alerts = (await (await request.get(`/api/brews/${second.id}/alerts`)).json()) as BrewAlert[];
    expect(alerts).toEqual([expect.objectContaining({ kind: 'fermentation_started', message: 'Check the krausen', addToTimeline: true })]);
  } finally {
    // The pill page's test starts a brew on this pill.
    await endRunning();
    if (profileId) await request.delete(`/api/brew-profiles/${profileId}`);
  }
});
