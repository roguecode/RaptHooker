// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScaleStrip, type ScaleStripProps } from './ScaleStrip';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(over: Partial<ScaleStripProps> = {}) {
  const props: ScaleStripProps = {
    name: 'Temperature',
    color: 'red',
    track: { from: 10, to: 30 },
    value: { from: 15, to: 25 },
    custom: false,
    left: 0,
    top: 0,
    height: 200,
    format: (v) => `${v.toFixed(1)} °C`,
    onChange: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
    ...over,
  };
  render(<ScaleStrip {...props} />);
  return { props, bar: screen.getByRole('scrollbar', { name: 'Temperature scale' }) };
}

describe('ScaleStrip', () => {
  it('shows where the range sits on its track, and whether it was set by hand', () => {
    const { bar } = setup();
    expect(bar.getAttribute('aria-orientation')).toBe('vertical');
    expect(bar.getAttribute('aria-valuetext')).toBe('15.0 °C to 25.0 °C (automatic)');
    // The top of the track is its highest value: 25 is a quarter of the way down from 30.
    expect(bar.style.top).toBe('25%');
    expect(bar.style.height).toBe('50%');
    cleanup();
    expect(setup({ custom: true }).bar.getAttribute('aria-valuetext')).toBe('15.0 °C to 25.0 °C');
  });

  it('moves, stretches and resets with the keyboard', () => {
    const { bar, props } = setup();
    fireEvent.keyDown(bar, { key: 'ArrowUp' });
    expect(props.onChange).toHaveBeenLastCalledWith({ from: 16, to: 26 }, true);
    fireEvent.keyDown(bar, { key: 'ArrowDown', shiftKey: true });
    expect(props.onChange).toHaveBeenLastCalledWith({ from: 14, to: 25 }, true);
    fireEvent.keyDown(bar, { key: '+' });
    expect(props.onChange).toHaveBeenLastCalledWith({ from: 17.5, to: 22.5 }, true);
    fireEvent.keyDown(bar, { key: '-' });
    expect(props.onChange).toHaveBeenLastCalledWith({ from: 10, to: 30 }, true);
    fireEvent.keyDown(bar, { key: '0' });
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it('keeps the range on its track', () => {
    const { bar, props } = setup({ value: { from: 20, to: 30 } });
    fireEvent.keyDown(bar, { key: 'ArrowUp' });
    expect(props.onChange).toHaveBeenLastCalledWith({ from: 20, to: 30 }, true);
  });

  it('drags the range and reports it once let go; a click that goes nowhere changes nothing', () => {
    const { bar, props } = setup();
    const strip = bar.parentElement!;
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      width: 14,
      height: 200,
      bottom: 200,
      right: 14,
    } as DOMRect);

    fireEvent.pointerDown(bar, { pointerId: 1, pointerType: 'mouse', button: 0, clientY: 100 });
    fireEvent.pointerUp(strip, { pointerId: 1, pointerType: 'mouse', clientY: 100 });
    expect(props.onChange).not.toHaveBeenCalled();

    // Down 50px of 200 is a quarter of the 20° track: 5° lower.
    fireEvent.pointerDown(bar, { pointerId: 1, pointerType: 'mouse', button: 0, clientY: 100 });
    fireEvent.pointerMove(strip, { pointerId: 1, pointerType: 'mouse', clientY: 150 });
    fireEvent.pointerUp(strip, { pointerId: 1, pointerType: 'mouse', clientY: 150 });
    expect(props.onChange).toHaveBeenLastCalledWith({ from: 10, to: 20 }, true);

    // The top end, dragged up past the end of the track, stops there.
    const top = bar.querySelector('[data-edge="to"]')!;
    fireEvent.pointerDown(top, { pointerId: 1, pointerType: 'mouse', button: 0, clientY: 50 });
    fireEvent.pointerMove(strip, { pointerId: 1, pointerType: 'mouse', clientY: -100 });
    fireEvent.pointerUp(strip, { pointerId: 1, pointerType: 'mouse', clientY: -100 });
    expect(props.onChange).toHaveBeenLastCalledWith({ from: 15, to: 30 }, true);
  });

  it('a drag that ends where it started lets the chart know without setting the scale', () => {
    const { bar, props } = setup({ value: { from: 10, to: 30 } });
    const strip = bar.parentElement!;
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      width: 14,
      height: 200,
      bottom: 200,
      right: 14,
    } as DOMRect);
    // The whole track is shown, so there's nowhere to move it.
    fireEvent.pointerDown(bar, { pointerId: 1, pointerType: 'mouse', button: 0, clientY: 100 });
    fireEvent.pointerMove(strip, { pointerId: 1, pointerType: 'mouse', clientY: 160 });
    fireEvent.pointerUp(strip, { pointerId: 1, pointerType: 'mouse', clientY: 160 });
    expect(props.onChange).not.toHaveBeenCalledWith(expect.anything(), true);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('goes back to automatic on a double-click or a double tap', () => {
    const { bar, props } = setup();
    const strip = bar.parentElement!;
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      width: 14,
      height: 200,
      bottom: 200,
      right: 14,
    } as DOMRect);
    fireEvent.doubleClick(bar);
    expect(props.onReset).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(bar, { pointerId: 2, pointerType: 'touch', clientY: 100 });
      fireEvent.pointerUp(strip, { pointerId: 2, pointerType: 'touch', clientY: 100 });
    }
    expect(props.onReset).toHaveBeenCalledTimes(2);
  });
});
