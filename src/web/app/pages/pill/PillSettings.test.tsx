// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HUB_SETTINGS } from '@rapthooker/shared';
import { makeBle, makePill, renderWithHub, type FakeRequest } from '../../test/render';
import { PillSettings } from './PillSettings';

const pill = makePill({ id: 'pill-1', offsets: { gravity: 0, temperature: 1 } });
const offset = () => screen.getByLabelText(/^Temperature offset/) as HTMLInputElement;

describe('PillSettings', () => {
  it("keeps a typed offset when the hub's settings arrive again", async () => {
    const view = await renderWithHub(<PillSettings pill={pill} />, { pills: [pill], afterLoad: true });
    expect(offset().value).toBe('1');
    fireEvent.change(offset(), { target: { value: '0.7' } });

    // Reconnecting sends the same settings again, as new objects.
    await view.push({ type: 'hub', hub: { ...DEFAULT_HUB_SETTINGS, units: { ...DEFAULT_HUB_SETTINGS.units } } });
    await view.push({ type: 'hello', pills: [pill], nearby: [], ble: makeBle(), clockSynced: true, hub: { ...DEFAULT_HUB_SETTINGS } });
    expect(offset().value).toBe('0.7');
  });

  it('shows the offset in the units picked', async () => {
    const view = await renderWithHub(<PillSettings pill={pill} />, { pills: [pill], afterLoad: true });
    await view.push({ type: 'hub', hub: { ...DEFAULT_HUB_SETTINGS, units: { gravity: 'sg', temperature: 'F' } } });
    expect(screen.getByLabelText(/^Temperature offset \(°F\)/)).toBe(offset());
    expect(offset().value).toBe('1.8');
  });

  it('saves an offset whose box was not changed as it was', async () => {
    const precise = makePill({ id: 'pill-1', offsets: { gravity: 0.00123, temperature: 0.4567 } });
    const view = await renderWithHub(<PillSettings pill={precise} />, {
      pills: [precise],
      afterLoad: true,
      routes: { 'PATCH /api/pills/*': (req: FakeRequest) => ({ ...precise, ...(req.body as object) }) },
    });
    expect((screen.getByLabelText(/^Gravity offset/) as HTMLInputElement).value).toBe('1.2');
    expect(offset().value).toBe('0.46');
    fireEvent.change(offset(), { target: { value: '0.5' } });
    // Submits the form: happy-dom's step check gets decimals wrong.
    fireEvent.submit(screen.getByRole('button', { name: 'Save calibration' }).closest('form')!);
    await waitFor(() => expect(view.calls('PATCH /api/pills/*')).toHaveLength(1));
    expect(view.calls('PATCH /api/pills/*')[0]!.body).toEqual({ offsets: { gravity: 0.00123, temperature: 0.5 } });
  });
});
