// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BrewProfile } from '@rapthooker/shared';
import { renderWithHub, settle, toastTexts, type FakeRequest } from '../../test/render';
import { ProfilesPanel } from './profiles';

const DAY = 86_400_000;
const LIST = 'GET /api/brew-profiles';
const ADD = 'POST /api/brew-profiles';
const PUT = 'PUT /api/brew-profiles/*';
const echo = (req: FakeRequest) => ({ id: 'prof-9', createdAt: 0, ...(req.body as object) });

const dialog = (name: string) => screen.getByRole('dialog', { name });
const submit = (scope: HTMLElement, name: string) => fireEvent.submit(within(scope).getByRole('button', { name }).closest('form')!);

describe('the profiles on the Brews page', () => {
  it('makes a profile from scratch, with an alert and a planned event', async () => {
    const view = await renderWithHub(<ProfilesPanel />, { routes: { [LIST]: [], [ADD]: echo } });
    await settle();
    expect(screen.getByText(/Make one with New profile/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    const editor = dialog('New profile');
    fireEvent.change(within(editor).getByLabelText(/^Name/), { target: { value: 'NEIPA' } });

    fireEvent.click(within(editor).getByRole('button', { name: 'Add alert' }));
    const alert = dialog('New alert for NEIPA');
    fireEvent.change(within(alert).getByRole('combobox'), { target: { value: 'attenuation_reached' } });
    fireEvent.change(within(alert).getByLabelText(/^Reaches/), { target: { value: '50' } });
    fireEvent.change(within(alert).getByLabelText(/^What to do/), { target: { value: 'Add 100 g Citra' } });
    submit(alert, 'Save alert');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New alert for NEIPA' })).toBeNull());
    // The alert's own form isn't the profile's.
    expect(view.calls(ADD)).toHaveLength(0);
    expect(within(editor).getByText('Attenuation reaches 50% · “Add 100 g Citra”')).toBeTruthy();

    fireEvent.click(within(editor).getByRole('button', { name: 'Add event' }));
    const plan = dialog('Plan an event');
    fireEvent.change(within(plan).getByLabelText(/^Day of the brew/), { target: { value: '4' } });
    fireEvent.change(within(plan).getByLabelText(/^Lasts/), { target: { value: '3' } });
    fireEvent.change(within(plan).getByLabelText(/^Details/), { target: { value: '100 g Citra' } });
    submit(plan, 'Add');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Plan an event' })).toBeNull());
    expect(within(editor).getByText('Day 4: Dry hop')).toBeTruthy();

    submit(editor, 'Save profile');
    await waitFor(() => expect(view.calls(ADD)).toHaveLength(1));
    const body = view.calls(ADD)[0]!.body as BrewProfile;
    expect(body).toMatchObject({
      name: 'NEIPA',
      alerts: [{ kind: 'attenuation_reached', threshold: 50, message: 'Add 100 g Citra', addToTimeline: true }],
      events: [{ offset: 3 * DAY, endOffset: 6 * DAY, kind: 'dry_hop', text: '100 g Citra', remind: true }],
    });
    expect(body.alerts[0]).not.toHaveProperty('pillIds');
    await waitFor(() => expect(toastTexts()).toContain('Saved "NEIPA": Pick it when you start a brew.'));
  });

  it("changes a profile's event, keeping its own time unless its day changes", async () => {
    const saved: BrewProfile = {
      id: 'prof-1',
      name: 'Saison',
      notes: '',
      createdAt: 0,
      alerts: [],
      // Saved from a brew: part way through day 3.
      events: [{ offset: Math.round(2.7 * DAY), endOffset: null, kind: 'addition', text: 'Nutrient', remind: false }],
    };
    const view = await renderWithHub(<ProfilesPanel />, { routes: { [LIST]: [saved], [PUT]: echo } });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = dialog('Edit profile');

    fireEvent.click(within(editor).getByRole('button', { name: 'Edit Day 3: Addition' }));
    let event = dialog('Edit planned event');
    expect((within(event).getByLabelText(/^Day of the brew/) as HTMLInputElement).value).toBe('3');
    fireEvent.change(within(event).getByLabelText(/^Details/), { target: { value: 'Nutrient, 2 g' } });
    submit(event, 'Save');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit planned event' })).toBeNull());

    fireEvent.click(within(editor).getByRole('button', { name: 'Edit Day 3: Addition' }));
    event = dialog('Edit planned event');
    fireEvent.change(within(event).getByLabelText(/^Day of the brew/), { target: { value: '0' } });
    submit(event, 'Save');
    expect(await within(event).findByText('Use a whole number from 1 to 365')).toBeTruthy();
    fireEvent.change(within(event).getByLabelText(/^Day of the brew/), { target: { value: '5' } });
    fireEvent.click(within(event).getByRole('checkbox', { name: /Remind me at its start and end/ }));
    submit(event, 'Save');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit planned event' })).toBeNull());

    submit(editor, 'Save');
    await waitFor(() => expect(view.calls(PUT)).toHaveLength(1));
    expect((view.calls(PUT)[0]!.body as BrewProfile).events).toEqual([
      { offset: 4 * DAY, endOffset: null, kind: 'addition', text: 'Nutrient, 2 g', remind: true },
    ]);
  });
});
