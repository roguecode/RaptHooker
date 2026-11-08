// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_HUB_SETTINGS, type HubSettings } from '@rapthooker/shared';
import { makeBle, renderWithHub, toastTexts, type FakeRequest } from '../../test/render';
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

  it('sets the decimals readings are shown with', async () => {
    const view = await renderWithHub(<HubSection />, { routes: { 'PUT /api/settings/hub': saved } });
    const sg = within(screen.getByRole('group', { name: 'Gravity in SG' }));
    expect(sg.getByRole('button', { name: '1.0123' }).getAttribute('aria-pressed')).toBe('true');
    expect(
      within(screen.getByRole('group', { name: 'Gravity in °P' }))
        .getByRole('button', { name: '3.1 °P' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(sg.getByRole('button', { name: '1.012' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Temperature' })).getByRole('button', { name: '19.63°' }));
    fireEvent.click(save());
    await waitFor(() => expect(toastTexts()).toContain('Hub settings saved'));
    expect(view.calls('PUT /api/settings/hub')[0]!.body).toEqual({
      ...DEFAULT_HUB_SETTINGS,
      decimals: { sg: 3, plato: 1, temperature: 2 },
    });
  });

  it('shows decimals set some other way among the choices', async () => {
    await renderWithHub(<HubSection />, { hub: { decimals: { sg: 5, plato: 1, temperature: 1 } } });
    const sg = within(screen.getByRole('group', { name: 'Gravity in SG' }));
    expect(sg.getAllByRole('button').map((b) => b.textContent)).toEqual(['1.012', '1.0123', '1.01235']);
    expect(sg.getByRole('button', { name: '1.01235' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the usual decimals for a hub from before they could be set', async () => {
    await renderWithHub(<HubSection />, { hub: { decimals: undefined } });
    const sg = within(screen.getByRole('group', { name: 'Gravity in SG' }));
    expect(sg.getByRole('button', { name: '1.0123' }).getAttribute('aria-pressed')).toBe('true');
  });

  it("switches the hub's Bluetooth off", async () => {
    const view = await renderWithHub(<HubSection />, { routes: { 'PUT /api/settings/hub': saved } });
    const bluetooth = screen.getByRole('switch', { name: 'Listen over Bluetooth' }) as HTMLButtonElement;
    expect(bluetooth.getAttribute('aria-checked')).toBe('true');
    expect(bluetooth.disabled).toBe(false);
    fireEvent.click(bluetooth);
    fireEvent.click(save());
    await waitFor(() => expect(toastTexts()).toContain('Hub settings saved'));
    expect(view.calls('PUT /api/settings/hub')[0]!.body).toEqual({ ...DEFAULT_HUB_SETTINGS, bluetooth: false });
  });

  it('keeps Bluetooth off when the config file switched it off', async () => {
    await renderWithHub(<HubSection />, { ble: makeBle({ state: 'off', offBy: 'config', adapter: null, adapters: [] }) });
    const bluetooth = screen.getByRole('switch', { name: 'Listen over Bluetooth' }) as HTMLButtonElement;
    expect(bluetooth.getAttribute('aria-checked')).toBe('false');
    expect(bluetooth.disabled).toBe(true);
    expect(screen.getByText(/Switched off in the hub's config file \(bluetooth\.enabled\)/)).toBeTruthy();
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
