// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_HUB_SETTINGS, type HubSettings } from '@rapthooker/shared';
import { renderWithHub, toastTexts, type FakeRequest } from '../../test/render';
import { setThemePref } from '../../theme';
import { HubSection } from './HubSection';

const saved = (req: FakeRequest) => req.body as HubSettings;
const nameInput = () => screen.getByLabelText(/^Hub name/) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

afterEach(() => setThemePref('auto'));

describe('Settings: Hub', () => {
  it('lets the owner rename the hub and change its default units', async () => {
    const view = await renderWithHub(<HubSection />, { routes: { 'PUT /api/settings/hub': saved } });
    expect(nameInput().value).toBe('RaptHooker');
    expect(nameInput().disabled).toBe(false);
    expect(save().disabled).toBe(true);

    fireEvent.change(nameInput(), { target: { value: '  Garage brewery ' } });
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Default temperature unit' })).getByRole('button', { name: '°F, Fahrenheit' }),
    );
    expect(save().disabled).toBe(false);
    fireEvent.click(save());

    await waitFor(() => expect(toastTexts()).toContain('Hub settings saved'));
    const body = view.calls('PUT /api/settings/hub')[0]!.body as HubSettings;
    expect(body).toEqual({ ...DEFAULT_HUB_SETTINGS, name: 'Garage brewery', units: { gravity: 'sg', temperature: 'F' } });
    expect(save().disabled).toBe(true);
    // The hub tells every browser about the change.
    await view.push({ type: 'hub', hub: body });
    expect(nameInput().value).toBe('Garage brewery');
  });

  it('needs a name', async () => {
    const view = await renderWithHub(<HubSection />, { routes: { 'PUT /api/settings/hub': saved } });
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    fireEvent.click(save());
    await waitFor(() => expect(toastTexts()).toContain("Couldn't save the hub settings: Check the hub name."));
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    expect(view.calls('PUT /api/settings/hub')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(nameInput().value).toBe('RaptHooker');
  });

  it('follows changes made elsewhere', async () => {
    const view = await renderWithHub(<HubSection />);
    await view.push({ type: 'hub', hub: { ...DEFAULT_HUB_SETTINGS, name: 'Shed' } });
    expect(nameInput().value).toBe('Shed');
  });

  it('is read-only for a viewer, apart from this browser’s own choices', async () => {
    await renderWithHub(<HubSection />, { session: { role: 'viewer', via: 'lan' }, hub: { name: 'Cellar' } });
    expect(nameInput().value).toBe('Cellar');
    expect(nameInput().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in with the owner PIN' }).getAttribute('href')).toBe('#/settings');
    const hubUnits = within(screen.getByRole('group', { name: 'Default gravity unit' }));
    expect((hubUnits.getByRole('button', { name: '°P, degrees Plato' }) as HTMLButtonElement).disabled).toBe(true);

    const browserUnits = within(screen.getByRole('group', { name: 'Gravity unit' }));
    fireEvent.click(browserUnits.getByRole('button', { name: '°P, degrees Plato' }));
    expect(browserUnits.getByRole('button', { name: '°P, degrees Plato' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Picked in this browser/)).toBeTruthy();

    fireEvent.click(within(screen.getByRole('group', { name: 'Theme' })).getByRole('button', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
