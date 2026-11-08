import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { placeTip, type TipArea } from './chartMath';
import './ChartTip.css';

export interface ChartTipRow {
  label: string;
  value: string;
  color: string;
  /** How the line is drawn, for its swatch. */
  line?: 'solid' | 'dashed' | 'dots';
}

export interface ChartTipContent {
  /** The pointer, CSS px within the tooltip's positioned parent. */
  x: number;
  y: number;
  /** Where the tooltip may go, in the same px. */
  area: TipArea;
  title: string;
  rows: ChartTipRow[];
}

export interface ChartTipHandle {
  show: (content: ChartTipContent) => void;
  hide: () => void;
}

/**
 * The values under the pointer, in a box beside it. Charts update it as the pointer moves (through `ref`), so only the
 * box re-renders. The legend or the list under the chart has the same values for screen readers.
 */
export function ChartTip({ ref }: { ref: Ref<ChartTipHandle> }) {
  const [tip, setTip] = useState<ChartTipContent | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  useImperativeHandle(ref, () => ({ show: setTip, hide: () => setTip(null) }), []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !tip) return;
    const { left, top } = placeTip(tip.x, tip.y, el.offsetWidth, el.offsetHeight, tip.area);
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={box} className="chart-tip" aria-hidden="true">
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="chart-tip-row">
          <span className={`chart-tip-swatch ${r.line ?? 'solid'}`} style={{ color: r.color }} />
          <span className="chart-tip-label">{r.label}</span>
          <span className="chart-tip-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
