// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { sgToPlato, type Brew } from '@rapthooker/shared';
import { makeBrew, renderWithHub, type FakeRequest } from '../../test/render';
import { EditBrewModal } from './EditBrewModal';

// Times with seconds, which the boxes don't show.
const ended = makeBrew({
  og: 1.0523,
  targetFg: 1.0121,
  startedAt: new Date('2026-01-02T10:30:45').getTime(),
  endedAt: new Date('2026-01-16T08:15:30').getTime(),
});
const PATCH = 'PATCH /api/brews/*';
const saved = (req: FakeRequest): Brew => ({ ...ended, ...(req.body as Partial<Brew>) });

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp, value: string) => fireEvent.change(field(label), { target: { value } });
// happy-dom's step check gets decimals wrong, so submit the form rather than clicking Save.
const save = () => fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);

async function open(hub = {}) {
  const onSaved = vi.fn();
  const view = await renderWithHub(<EditBrewModal brew={ended} onClose={() => undefined} onSaved={onSaved} />, {
    routes: { [PATCH]: saved },
    afterLoad: true,
    ...hub,
  });
  return { view, onSaved };
}

describe('EditBrewModal', () => {
  it('only sends what was changed', async () => {
    const { view, onSaved } = await open();
    expect(field(/^Original gravity/).value).toBe('1.0523');
    expect(field(/^Target FG/).value).toBe('1.0121');
    expect(field(/^Started/).value).toBe('2026-01-02T10:30');

    type(/^Name/, 'Hazy IPA #5');
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // Sending the times back to the minute would make the hub work the finished brew's stats out again.
    expect(view.calls(PATCH)[0]!.body).toEqual({ name: 'Hazy IPA #5', style: 'New England IPA', notes: '' });
  });

  it('sends a changed time or gravity', async () => {
    const { view, onSaved } = await open();
    type(/^Started/, '2026-01-02T09:00');
    type(/^Original gravity/, '1.0600');
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(view.calls(PATCH)[0]!.body).toEqual({
      name: 'Hazy IPA #4',
      style: 'New England IPA',
      notes: '',
      og: 1.06,
      startedAt: new Date('2026-01-02T09:00').getTime(),
    });
  });

  it('leaves gravities shown in °P alone unless they change', async () => {
    const { view, onSaved } = await open({ hub: { units: { gravity: 'plato', temperature: 'C' } } });
    expect(field(/^Original gravity \(°P\)/).value).toBe(sgToPlato(1.0523).toFixed(1));
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(view.calls(PATCH)[0]!.body).not.toHaveProperty('og');
    expect(view.calls(PATCH)[0]!.body).not.toHaveProperty('targetFg');
  });
});
