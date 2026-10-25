// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Brew } from '@rapthooker/shared';
import { makeBrew, makePill, renderWithHub, toastTexts, type FakeRequest } from '../../test/render';
import { StartBrewModal } from './StartBrewModal';

const pill = makePill({ id: 'pill-1', name: 'Hazy IPA' });
const started = (req: FakeRequest): Brew => makeBrew({ ...(req.body as Partial<Brew>), id: 'brew-9' });

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp, value: string) => fireEvent.change(field(label), { target: { value } });
// Submits the form rather than clicking: happy-dom's step check gets decimals wrong (1.050 % 0.001 isn't 0 in floating
// point), so it would block a submit that a browser allows.
const start = () => fireEvent.submit(screen.getByRole('button', { name: 'Start brew' }).closest('form')!);

describe('StartBrewModal', () => {
  it('needs a name before it can start', async () => {
    await renderWithHub(<StartBrewModal pill={pill} onClose={() => undefined} />, { pills: [pill] });
    expect(screen.getByRole('dialog', { name: 'Start a brew' }).textContent).toContain('On Hazy IPA.');
    const button = screen.getByRole('button', { name: 'Start brew' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    type(/^Name/, '   ');
    expect(button.disabled).toBe(true);
    type(/^Name/, 'West Coast IPA');
    expect(button.disabled).toBe(false);
    expect(screen.getByText(/With no OG, RaptHooker takes it from the pill/)).toBeTruthy();
    type(/^Original gravity/, '1.060');
    expect(screen.queryByText(/With no OG/)).toBeNull();
  });

  it('checks the gravities before sending anything', async () => {
    const onClose = vi.fn();
    const view = await renderWithHub(<StartBrewModal pill={pill} onClose={onClose} />, {
      pills: [pill],
      routes: { 'POST /api/brews': started },
    });
    type(/^Name/, 'Stout');
    type(/^Original gravity/, '1.5');
    type(/^Target final gravity/, '0.5');
    start();

    await waitFor(() => expect(toastTexts()).toContain("Couldn't start the brew: Check Original gravity, Target final gravity."));
    expect(screen.getAllByText('Use a gravity between 0.9500 and 1.2000')).toHaveLength(2);
    expect(view.calls('POST /api/brews')).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    // The errors clear as the fields are fixed.
    type(/^Original gravity/, '1.050');
    expect(screen.getAllByText('Use a gravity between 0.9500 and 1.2000')).toHaveLength(1);
  });

  it('starts a brew', async () => {
    const onClose = vi.fn();
    const view = await renderWithHub(<StartBrewModal pill={pill} onClose={onClose} />, {
      pills: [pill],
      routes: { 'POST /api/brews': started },
    });
    type(/^Name/, '  Stout  ');
    type(/^Style/, 'Oatmeal Stout');
    type(/^Original gravity/, '1.050');
    type(/^Target final gravity/, '1.014');
    start();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(view.calls('POST /api/brews')[0]!.body).toEqual({
      pillId: 'pill-1',
      name: 'Stout',
      style: 'Oatmeal Stout',
      notes: '',
      og: 1.05,
      targetFg: 1.014,
    });
    expect(toastTexts()).toContain('Stout started: Cheers! 🍻');
  });

  it('takes gravities in °P and a start time in the past', async () => {
    const view = await renderWithHub(<StartBrewModal pill={pill} onClose={() => undefined} />, {
      pills: [pill],
      hub: { units: { gravity: 'plato', temperature: 'C' } },
      afterLoad: true,
      routes: { 'POST /api/brews': started },
    });
    type(/^Name/, 'Helles');
    type(/^Original gravity \(°P\)/, '12');
    fireEvent.click(screen.getByRole('checkbox', { name: /It started earlier/ }));
    type(/^Started at/, '2026-01-02T10:30');
    start();

    await waitFor(() => expect(view.calls('POST /api/brews')).toHaveLength(1));
    const body = view.calls('POST /api/brews')[0]!.body as { og: number; startedAt: number; targetFg: number | null };
    expect(body.og).toBeCloseTo(1.0484, 3);
    expect(body.targetFg).toBeNull();
    expect(body.startedAt).toBe(new Date('2026-01-02T10:30').getTime());
  });

  it("says why the hub wouldn't start it", async () => {
    const onClose = vi.fn();
    await renderWithHub(<StartBrewModal pill={pill} onClose={onClose} />, {
      pills: [pill],
      routes: { 'POST /api/brews': () => new Response('{"error":"A brew is already running on this pill"}', { status: 409 }) },
    });
    type(/^Name/, 'Stout');
    start();
    await waitFor(() => expect(toastTexts()).toContain("Couldn't start the brew: A brew is already running on this pill"));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Start brew' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
