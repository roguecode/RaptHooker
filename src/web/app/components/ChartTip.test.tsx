// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChartTip, type ChartTipHandle } from './ChartTip';

afterEach(cleanup);

describe('ChartTip', () => {
  it('shows the values under the pointer beside it, and goes when the pointer leaves', () => {
    const ref = createRef<ChartTipHandle>();
    const { container } = render(<ChartTip ref={ref} />);
    expect(container.querySelector('.chart-tip')).toBeNull();

    act(() =>
      ref.current!.show({
        x: 100,
        y: 120,
        area: { left: 0, top: 0, right: 600, bottom: 300 },
        title: 'Sat, Nov 7, 9:00 PM',
        rows: [
          { label: 'Gravity (SG)', value: '1.0123', color: 'rgb(96, 165, 250)' },
          { label: 'Velocity', value: '-2.1 pts/day', color: 'rgb(34, 211, 238)', line: 'dashed' },
        ],
      }),
    );
    const tip = container.querySelector<HTMLElement>('.chart-tip')!;
    // The legend has the same values for screen readers.
    expect(tip.getAttribute('aria-hidden')).toBe('true');
    expect(tip.querySelector('.chart-tip-title')?.textContent).toBe('Sat, Nov 7, 9:00 PM');
    const rows = [...tip.querySelectorAll('.chart-tip-row')].map((r) => [
      r.querySelector('.chart-tip-label')?.textContent,
      r.querySelector('.chart-tip-value')?.textContent,
      r.querySelector<HTMLElement>('.chart-tip-swatch')?.className,
      r.querySelector<HTMLElement>('.chart-tip-swatch')?.style.color,
    ]);
    expect(rows).toEqual([
      ['Gravity (SG)', '1.0123', 'chart-tip-swatch solid', 'rgb(96, 165, 250)'],
      ['Velocity', '-2.1 pts/day', 'chart-tip-swatch dashed', 'rgb(34, 211, 238)'],
    ]);
    // No layout here, so the box has no size: it starts just right of the pointer, level with it.
    expect(tip.style.transform).toBe('translate(116px, 120px)');

    act(() => ref.current!.hide());
    expect(container.querySelector('.chart-tip')).toBeNull();
  });
});
