// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BrewEvent } from '@rapthooker/shared';
import { fromLocalInput, toLocalInput } from '../../format';
import { makeBrew, renderWithHub, settle, toastTexts, type FakeRequest } from '../../test/render';
import { EventModal, EventsSection } from './events';

// Times with seconds, which the boxes don't show.
const hop: BrewEvent = {
  id: 'ev-1',
  brewId: 'brew-1',
  at: new Date('2026-01-03T09:15:20').getTime(),
  endAt: new Date('2026-01-05T18:40:10').getTime(),
  kind: 'dry_hop',
  text: '100 g Citra',
  hidden: false,
};
const brew = makeBrew({
  startedAt: new Date('2026-01-02T10:30:45').getTime(),
  endedAt: new Date('2026-01-16T08:15:30').getTime(),
  events: [hop],
});
const PUT = 'PUT /api/brews/*/events/*';
const POST = 'POST /api/brews/*/events';
const echo = (req: FakeRequest) => ({ ...hop, ...(req.body as Partial<BrewEvent>) });

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const submit = (name: string) => fireEvent.submit(screen.getByRole('button', { name }).closest('form')!);

async function openModal(event: BrewEvent | null) {
  const onSaved = vi.fn();
  const view = await renderWithHub(<EventModal brew={brew} event={event} onClose={() => undefined} onSaved={onSaved} />, {
    routes: { [PUT]: echo, [POST]: echo },
    afterLoad: true,
  });
  return { view, onSaved };
}

describe('EventsSection', () => {
  it('says how long an event lasted, and hides it from the chart without touching its times', async () => {
    const onChanged = vi.fn();
    const view = await renderWithHub(<EventsSection brew={brew} onChanged={onChanged} />, { routes: { [PUT]: echo } });
    await settle();
    expect(screen.getByText(/ → .* \(2\.4 days\)$/)).toBeTruthy();
    expect(screen.queryByText(/Not on the chart/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Hide dry hop from the chart' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(view.calls(PUT)[0]!.body).toEqual({ at: hop.at, kind: 'dry_hop', text: '100 g Citra', hidden: true });
  });

  it('marks an event hidden from the chart, and only the owner can show it again', async () => {
    const hidden = makeBrew({ ...brew, events: [{ ...hop, endAt: null, hidden: true }] });
    const view = await renderWithHub(<EventsSection brew={hidden} />, { routes: { [PUT]: echo } });
    await settle();
    expect(screen.getByText(/ · Not on the chart$/)).toBeTruthy();
    expect(screen.queryByText(/→/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show dry hop on the chart' }));
    await waitFor(() => expect(view.calls(PUT)).toHaveLength(1));
    expect(view.calls(PUT)[0]!.body).toMatchObject({ hidden: false });
    view.unmount();

    await renderWithHub(<EventsSection brew={hidden} />, { session: { role: 'viewer' } });
    await settle();
    expect(screen.getByText(/ · Not on the chart$/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /on the chart/ })).toBeNull();
  });
});

describe('EventModal', () => {
  it("keeps an event's own times unless they change", async () => {
    const { view, onSaved } = await openModal(hop);
    expect(field('When').value).toBe('2026-01-03T09:15');
    expect(field('Until').value).toBe('2026-01-05T18:40');
    submit('Save');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(view.calls(PUT)[0]!.body).toEqual({ at: hop.at, endAt: hop.endAt, kind: 'dry_hop', text: '100 g Citra' });
  });

  it('adds an end, and takes it away', async () => {
    const { view, onSaved } = await openModal(null);
    expect(screen.queryByLabelText('Until')).toBeNull();
    type('When', '2026-01-04T08:00');
    fireEvent.click(screen.getByRole('button', { name: 'Add an end time' }));
    type('Until', '2026-01-07T20:30');
    submit('Add');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(view.calls(POST)[0]!.body).toEqual({
      at: new Date('2026-01-04T08:00').getTime(),
      endAt: new Date('2026-01-07T20:30').getTime(),
      kind: 'dry_hop',
      text: '',
    });
    view.unmount();

    const again = await openModal(hop);
    fireEvent.click(screen.getByRole('button', { name: 'Remove the end' }));
    expect(screen.queryByLabelText('Until')).toBeNull();
    submit('Save');
    await waitFor(() => expect(again.onSaved).toHaveBeenCalled());
    expect(again.view.calls(PUT)[0]!.body).toMatchObject({ at: hop.at, endAt: null });
  });

  it('plans an end a day on for an event that has just begun, and ends one logged later now', async () => {
    await renderWithHub(<EventModal brew={makeBrew()} event={null} onClose={() => undefined} />, { afterLoad: true });
    const when = field('When').value;
    fireEvent.click(screen.getByRole('button', { name: 'Add an end time' }));
    expect(field('Until').value).toBe(toLocalInput(fromLocalInput(when) + 24 * 3_600_000));

    type('When', toLocalInput(Date.now() - 48 * 3_600_000));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the end' }));
    const before = Date.now();
    fireEvent.click(screen.getByRole('button', { name: 'Add an end time' }));
    expect([toLocalInput(before), toLocalInput(Date.now())]).toContain(field('Until').value);
  });

  it("won't save an end before the start", async () => {
    const { view, onSaved } = await openModal(hop);
    type('Until', '2026-01-03T09:15');
    submit('Save');
    await settle();
    expect(toastTexts()).toContain("Couldn't save: The end has to be after the start.");
    expect(screen.getByText('The end has to be after the start')).toBeTruthy();
    expect(view.calls(PUT)).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
