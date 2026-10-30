// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmoothingStepper, useChartSmoothing } from './ChartSmoothing';
import { SMOOTHING_STEPS_MS } from './chartMath';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function Harness() {
  const [step, setStep] = useChartSmoothing();
  return <SmoothingStepper step={step} onChange={setStep} />;
}

describe('chart smoothing', () => {
  it('starts with the readings as they are and steps up and down within its range', () => {
    render(<Harness />);
    const less = screen.getByRole('button', { name: 'Less smoothing' });
    const more = screen.getByRole('button', { name: 'More smoothing' });
    const group = screen.getByRole('group', { name: 'Smoothing' });
    expect(group.textContent).toContain('0');
    expect(less.hasAttribute('disabled')).toBe(true);

    fireEvent.click(more);
    fireEvent.click(more);
    expect(group.textContent).toContain('2');
    expect(group.getAttribute('title')).toContain('30 min');
    expect(localStorage.getItem('rapthooker.smoothing')).toBe('2');

    for (let i = 0; i < SMOOTHING_STEPS_MS.length; i++) fireEvent.click(more);
    expect(more.hasAttribute('disabled')).toBe(true);
    expect(group.textContent).toContain(String(SMOOTHING_STEPS_MS.length - 1));
  });

  it("remembers the choice in this browser, and ignores one it can't use", () => {
    localStorage.setItem('rapthooker.smoothing', '3');
    const { unmount } = render(<Harness />);
    expect(screen.getByRole('group', { name: 'Smoothing' }).getAttribute('title')).toContain('1 h');
    unmount();
    localStorage.setItem('rapthooker.smoothing', '99');
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Less smoothing' }).hasAttribute('disabled')).toBe(true);
  });
});
