import { useState, type FocusEvent, type InputHTMLAttributes } from 'react';

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max'>;

/** What's typed as a number: NaN when the box is empty or isn't a number yet. */
const parse = (text: string): number => (text.trim() === '' ? NaN : Number(text));
const show = (value: number): string => (Number.isFinite(value) ? String(value) : '');

/**
 * A number box that can be cleared and typed into freely. What's typed is kept as it is and passed on as a number (NaN
 * while the box is empty, so the form's check can say so). When the box loses focus, an empty one gets `fallback` and
 * the number is kept between `min` and `max`.
 */
export function NumberInput({
  value,
  onValue,
  min,
  max,
  fallback,
  onBlur,
  ...rest
}: InputProps & {
  value: number;
  onValue: (value: number) => void;
  min?: number;
  max?: number;
  fallback?: number;
}) {
  const [text, setText] = useState(() => show(value));
  const [last, setLast] = useState(value);
  // A new value from elsewhere (a preset button, say) replaces what's typed.
  if (!Object.is(value, last)) {
    setLast(value);
    if (!Object.is(value, parse(text))) setText(show(value));
  }

  const report = (next: number) => {
    setLast(next);
    onValue(next);
  };

  const settle = (e: FocusEvent<HTMLInputElement>) => {
    const typed = parse(text);
    let next = Number.isFinite(typed) ? typed : (fallback ?? typed);
    if (Number.isFinite(next)) {
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
    }
    if (!Object.is(next, typed)) {
      setText(show(next));
      report(next);
    }
    onBlur?.(e);
  };

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        report(parse(e.target.value));
      }}
      onBlur={settle}
    />
  );
}
