// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NumberInput } from './NumberInput';

afterEach(cleanup);

function Form() {
  const [minutes, setMinutes] = useState(15);
  return (
    <>
      <NumberInput aria-label="Minutes" min={1} max={60} fallback={15} value={minutes} onValue={setMinutes} />
      <output>{String(minutes)}</output>
      <button type="button" onClick={() => setMinutes(5)}>
        5 min
      </button>
    </>
  );
}

const box = () => screen.getByLabelText('Minutes') as HTMLInputElement;
const typed = (value: string) => fireEvent.change(box(), { target: { value } });
const value = () => screen.getByRole('status').textContent;

describe('NumberInput', () => {
  it('can be cleared and typed into', () => {
    render(<Form />);
    typed('');
    expect(box().value).toBe('');
    expect(value()).toBe('NaN');
    typed('3');
    typed('30');
    expect(box().value).toBe('30');
    expect(value()).toBe('30');
  });

  it('fills in an empty box and keeps the number in range when it loses focus', () => {
    render(<Form />);
    typed('');
    fireEvent.blur(box());
    expect(box().value).toBe('15');
    expect(value()).toBe('15');
    typed('90');
    expect(value()).toBe('90');
    fireEvent.blur(box());
    expect(box().value).toBe('60');
    expect(value()).toBe('60');
  });

  it('shows a value set elsewhere', () => {
    render(<Form />);
    typed('');
    fireEvent.click(screen.getByRole('button', { name: '5 min' }));
    expect(box().value).toBe('5');
  });
});
