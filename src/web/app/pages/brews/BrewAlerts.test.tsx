// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AlertRule, BrewAlert, BrewProfile } from '@rapthooker/shared';
import { makeBrew, makeReading, renderWithHub, settle, toastTexts, type FakeRequest } from '../../test/render';
import { BrewAlertsSection } from './BrewAlerts';

const HOUR = 3_600_000;
const brew = makeBrew({ id: 'brew-1', pillId: 'pill-1', name: 'Hazy #5', startedAt: Date.now() - 50 * HOUR, endedAt: null, events: [] });
const dryHop: BrewAlert = {
  id: 'ba-1',
  brewId: 'brew-1',
  createdAt: 0,
  name: 'Dry hop',
  enabled: true,
  kind: 'attenuation_reached',
  threshold: 50,
  hours: 48,
  cooldownMin: 60,
  channelIds: 'all',
  message: 'Add 100 g Citra',
  addToTimeline: true,
  active: true,
  lastFiredAt: Date.now() - 2 * HOUR,
  waitingForGravity: null,
};
const rule = (over: Partial<AlertRule>): AlertRule =>
  ({ id: 'r1', name: 'Too warm', enabled: true, pillIds: 'all', kind: 'temp_above', threshold: 24, active: [], ...over }) as AlertRule;
const ALERTS = 'GET /api/brews/*/alerts';
const ADD = 'POST /api/brews/*/alerts';

describe("a brew's own alerts", () => {
  it('lists them with when they went off, and the hub rules that watch the brew too', async () => {
    await renderWithHub(<BrewAlertsSection brew={brew} />, {
      routes: {
        [ALERTS]: [dryHop],
        'GET /api/alerts/rules': [rule({}), rule({ id: 'r2', name: 'Other pill', pillIds: ['pill-2'] })],
      },
    });
    await settle();
    expect(screen.getByText('Dry hop')).toBeTruthy();
    expect(screen.getByText('Attenuation reaches 50% · once a brew')).toBeTruthy();
    expect(screen.getByText('“Add 100 g Citra”')).toBeTruthy();
    expect(screen.getByText(/^Went off 2 hours? ago|^Went off 2 h/)).toBeTruthy();
    expect(screen.getByText(/Also watching it, from Alerts: Too warm\./)).toBeTruthy();
  });

  it('says what a velocity alert is waiting for at the start of the brew, and watches the readings for it', async () => {
    const slowing: BrewAlert = {
      ...dryHop,
      id: 'ba-2',
      name: 'Slowing',
      kind: 'velocity_slow',
      threshold: 1,
      message: '',
      active: false,
      lastFiredAt: null,
      waitingForGravity: 1.0427,
    };
    let waiting = true;
    const view = await renderWithHub(<BrewAlertsSection brew={brew} />, {
      routes: { [ALERTS]: () => [waiting ? slowing : { ...slowing, waitingForGravity: null }], 'GET /api/alerts/rules': [] },
    });
    await settle();
    expect(screen.getByText('Waiting for the gravity to reach 1.0427, 2 points below where the pill started')).toBeTruthy();
    waiting = false;
    const reading = makeReading({ gravity: 1.0426 });
    await view.push({ type: 'reading', pillId: 'pill-2', reading });
    await settle();
    expect(screen.queryByText('Watching')).toBeNull();
    await view.push({ type: 'reading', pillId: 'pill-1', reading });
    expect(await screen.findByText('Watching')).toBeTruthy();
  });

  it('adds one for the brew, starting as "Fermentation starts"', async () => {
    const view = await renderWithHub(<BrewAlertsSection brew={brew} />, {
      routes: { [ALERTS]: [], [ADD]: (req: FakeRequest) => ({ ...dryHop, ...(req.body as object) }) },
    });
    await settle();
    expect(screen.getByText(/Alerts that watch this brew alone/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    expect(await screen.findByRole('dialog', { name: 'New alert for Hazy #5' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save alert' }));
    await waitFor(() => expect(view.calls(ADD)).toHaveLength(1));
    const body = view.calls(ADD)[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'fermentation_started', threshold: 3, addToTimeline: true });
    expect(body).not.toHaveProperty('pillIds');
    expect(body).not.toHaveProperty('onlyDuringBrew');
  });

  it("uses a profile on the brew, and saves the brew's alerts and events as one", async () => {
    const profile: BrewProfile = { id: 'prof-1', name: 'NEIPA', notes: '', createdAt: 0, alerts: [], events: [] };
    const withHop = makeBrew({
      ...brew,
      events: [
        {
          id: 'e1',
          brewId: 'brew-1',
          at: brew.startedAt + 72 * HOUR,
          endAt: null,
          kind: 'dry_hop',
          text: 'Citra',
          hidden: false,
          remind: false,
        },
      ],
    });
    const view = await renderWithHub(<BrewAlertsSection brew={withHop} />, {
      routes: {
        [ALERTS]: [dryHop],
        'GET /api/brew-profiles': [profile],
        'POST /api/brews/*/profile': withHop,
        'POST /api/brew-profiles': (req: FakeRequest) => ({ ...(req.body as object), id: 'prof-2', createdAt: 0 }),
      },
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Use a profile' }));
    expect(await screen.findByText(/Adds to this brew, timed from its start \(0 alerts, 0 planned events\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add to the brew' }));
    await waitFor(() => expect(view.calls('POST /api/brews/*/profile')).toHaveLength(1));
    expect(view.calls('POST /api/brews/*/profile')[0]!.body).toEqual({ profileId: 'prof-1' });

    fireEvent.click(screen.getByRole('button', { name: 'Save as a profile' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as a profile' });
    expect(dialog.textContent).toContain('1 alert, 1 planned event');
    expect(dialog.textContent).toContain('Day 4: Dry hop: Citra');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Hazy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(view.calls('POST /api/brew-profiles')).toHaveLength(1));
    expect(view.calls('POST /api/brew-profiles')[0]!.body).toMatchObject({
      name: 'Hazy',
      alerts: [expect.objectContaining({ name: 'Dry hop', kind: 'attenuation_reached', message: 'Add 100 g Citra' })],
      events: [{ offset: 72 * HOUR, endOffset: null, kind: 'dry_hop', text: 'Citra', remind: true }],
    });
    const sent = view.calls('POST /api/brew-profiles')[0]!.body as { alerts: Record<string, unknown>[] };
    expect(sent.alerts[0]).not.toHaveProperty('lastFiredAt');
    await waitFor(() => expect(toastTexts()).toContain('Saved "Hazy": Pick it when you start a brew.'));
  });

  it("only lets a viewer look, and a finished brew's alerts can't be added to", async () => {
    await renderWithHub(<BrewAlertsSection brew={brew} />, { session: { role: 'viewer' }, routes: { [ALERTS]: [dryHop] } });
    await settle();
    expect(screen.getByText('Dry hop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add alert' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as a profile' })).toBeNull();
  });
});
