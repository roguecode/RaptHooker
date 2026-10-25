// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toLocalInput } from '../format';
import { RangePicker } from './RangePicker';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DAY = 86_400_000;

function setup(props: Partial<Parameters<typeof RangePicker>[0]> = {}) {
  const onPreset = vi.fn();
  const onCustom = vi.fn();
  const view = render(<RangePicker preset="24h" custom={null} hasBrew={false} onPreset={onPreset} onCustom={onCustom} {...props} />);
  return { onPreset, onCustom, view };
}

const button = (name: string) => screen.getByRole('button', { name });
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('RangePicker', () => {
  it('offers the preset ranges and marks the one in use', () => {
    const { onPreset } = setup();
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    expect(names).toEqual([
      'Last 6 hours',
      'Last 24 hours',
      'Last 3 days',
      'Last 7 days',
      'Last 14 days',
      'Last 30 days',
      'Everything recorded',
      'Custom',
    ]);
    expect(button('Last 24 hours').getAttribute('aria-pressed')).toBe('true');
    expect(button('Last 24 hours').textContent).toBe('24H');

    fireEvent.click(button('Last 7 days'));
    expect(onPreset).toHaveBeenCalledWith('7d');
  });

  it('offers the brew while one is running', () => {
    const { onPreset } = setup({ hasBrew: true, preset: 'brew' });
    expect(button('Since the brew started').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button('Everything recorded'));
    expect(onPreset).toHaveBeenCalledWith('all');
  });

  it('picks a custom range, and says what is wrong with one', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-15T09:30:00') });
    const { onCustom } = setup();
    fireEvent.click(button('Custom'));
    expect(button('Custom').getAttribute('aria-expanded')).toBe('true');
    const form = screen.getByRole('form', { name: 'Custom range' });
    // It starts from the last week.
    expect(input('From').value).toBe('2026-03-08T09:30');
    expect(input('To').value).toBe('2026-03-15T09:30');

    fireEvent.change(input('From'), { target: { value: '2026-03-10T12:00' } });
    fireEvent.change(input('To'), { target: { value: '2026-03-09T12:00' } });
    fireEvent.submit(form);
    expect(screen.getByRole('alert').textContent).toBe('The start has to be before the end');
    expect(onCustom).not.toHaveBeenCalled();

    fireEvent.change(input('To'), { target: { value: '2026-03-10T12:05' } });
    fireEvent.submit(form);
    expect(screen.getByRole('alert').textContent).toBe('Pick at least 15 minutes');

    fireEvent.change(input('To'), { target: { value: '2026-03-12T08:00' } });
    fireEvent.submit(form);
    expect(onCustom).toHaveBeenCalledWith({ from: new Date('2026-03-10T12:00').getTime(), to: new Date('2026-03-12T08:00').getTime() });
    expect(screen.queryByRole('form', { name: 'Custom range' })).toBeNull();
  });

  it('opens on the custom range in use, and closes when a preset is picked', () => {
    const custom = { from: Date.now() - 3 * DAY, to: Date.now() - DAY };
    setup({ preset: 'custom', custom });
    expect(button('Custom').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button('Custom'));
    expect(input('From').value).toBe(toLocalInput(custom.from));
    expect(input('To').value).toBe(toLocalInput(custom.to));

    fireEvent.click(button('Last 6 hours'));
    expect(screen.queryByRole('form', { name: 'Custom range' })).toBeNull();
  });
});
