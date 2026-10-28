// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { makeBrew, makePill, renderWithHub, settle, toastTexts } from '../test/render';
import { setPalette, setThemePref } from '../theme';
import { ImageLinkButton } from './ImageLink';

vi.mock('../pages/settings/copy', () => ({ copyText: vi.fn(async () => true) }));

const picture = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'Content-Type': 'image/jpeg' } });
const ADDRESSES = [
  { kind: 'lan', url: 'http://192.168.1.20:8080', qrSvg: '' },
  { kind: 'mdns', url: 'http://rapthooker.local:8080', qrSvg: '' },
];

const link = () => new URL((screen.getByLabelText('Link for the screen') as HTMLInputElement).value);
const query = () => Object.fromEntries(link().searchParams);

afterEach(() => {
  setThemePref('auto');
  setPalette('violet');
});

describe('image link', () => {
  it("makes a link to one pill's picture in this browser's look and units, and previews it", async () => {
    const pill = makePill({ brew: makeBrew() });
    const view = await renderWithHub(<ImageLinkButton pill={pill} />, {
      pills: [pill],
      hub: { units: { gravity: 'plato', temperature: 'F' } },
      routes: { 'GET /api/system/addresses': ADDRESSES, 'GET /api/pills/*/image.*': picture },
    });
    setThemePref('light');
    setPalette('ocean');
    fireEvent.click(screen.getByRole('button', { name: 'Image link' }));
    expect(screen.getByRole('dialog', { name: `Image link for ${pill.name}` })).toBeTruthy();

    // A small screen on the network needs the hub's IP address rather than its .local name.
    await waitFor(() => expect(link().origin).toBe('http://192.168.1.20:8080'));
    expect(link().pathname).toBe(`/api/pills/${pill.id}/image.jpg`);
    expect(query()).toMatchObject({
      w: '240',
      h: '240',
      theme: 'light',
      palette: 'ocean',
      show: 'name,status,gravity,temperature,brew,chart',
      range: 'brew',
      gravity: 'plato',
      temp: 'F',
    });
    expect(query().tz).toBeTruthy();

    // The preview is the hub's own picture for the same address.
    await waitFor(() => expect(screen.getByRole('img', { name: 'Preview of the picture' })).toBeTruthy(), { timeout: 3000 });
    const previewed = view.calls('GET /api/pills/*/image.*').at(-1)!;
    expect(previewed.path).toBe(link().pathname);
    expect(Object.fromEntries(previewed.query)).toEqual(query());

    fireEvent.click(screen.getByRole('button', { name: 'Everything' }));
    expect(query().show).toBe('header,name,status,gravity,temperature,brew,progress,chart,stats');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Graph' }));
    expect(query().show).toBe('header,name,status,gravity,temperature,brew,progress,stats');
    expect(query().range).toBeUndefined();
    expect(screen.getByText('Custom')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Screen size' }), { target: { value: 'fhd' } });
    expect(query()).toMatchObject({ w: '1920', h: '1080' });
    fireEvent.click(screen.getByRole('button', { name: 'Swap width and height' }));
    expect(query()).toMatchObject({ w: '1080', h: '1920' });
    expect((screen.getByRole('combobox', { name: 'Screen size' }) as HTMLSelectElement).value).toBe('custom');

    fireEvent.click(screen.getByRole('button', { name: 'PNG' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hops' }));
    fireEvent.click(screen.getByRole('button', { name: '°C' }));
    expect(link().pathname).toBe(`/api/pills/${pill.id}/image.png`);
    expect(query()).toMatchObject({ theme: 'dark', palette: 'hops', temp: 'C' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Hub address in the link' }), {
      target: { value: 'http://rapthooker.local:8080' },
    });
    expect(link().origin).toBe('http://rapthooker.local:8080');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(toastTexts()).toContain('Image link copied');
    // The browser's own look isn't changed by any of this.
    expect(document.documentElement.dataset.palette).toBe('ocean');

    // Opened again, it remembers the screen, file type and what to show, and starts from the browser's look.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Image link' }));
    await waitFor(() => expect(link().origin).toBe('http://rapthooker.local:8080'));
    expect(link().pathname).toBe(`/api/pills/${pill.id}/image.png`);
    expect(query()).toMatchObject({ w: '1080', h: '1920', theme: 'light', palette: 'ocean', temp: 'F' });
  });

  it('makes a link to a picture of every pill, optionally just the brewing ones', async () => {
    const pill = makePill();
    await renderWithHub(<ImageLinkButton />, {
      pills: [pill],
      routes: { 'GET /api/system/addresses': [], 'GET /api/image.*': picture },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Image link' }));
    expect(screen.getByRole('dialog', { name: 'Image link for all pills' })).toBeTruthy();
    // Without a known address, the one this page came from.
    await waitFor(() => expect(link().origin).toBe(window.location.origin));
    expect(link().pathname).toBe('/api/image.jpg');
    expect(query().brewing).toBeUndefined();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only pills with a brew running' }));
    expect(query().brewing).toBe('1');
  });
});
