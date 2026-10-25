import { useId, useMemo } from 'react';

/** A small area chart (gravity) with an optional faint second line (temperature). */
export function Sparkline({
  ts,
  values,
  secondary,
  skip,
  color,
  secondaryColor = 'var(--series-temp)',
  from,
  to,
  minSpan = 0,
  secondaryMinSpan = 0,
}: {
  ts: number[];
  values: (number | null)[];
  secondary?: (number | null)[];
  /** Readings to leave out of the main line without breaking it (History.implausible: the pill wasn't floating). */
  skip?: (boolean | null)[];
  color: string;
  secondaryColor?: string;
  from: number;
  to: number;
  /** Smallest vertical range, so sensor noise on a flat line isn't blown up. */
  minSpan?: number;
  secondaryMinSpan?: number;
}) {
  const id = useId().replace(/:/g, '');
  const W = 300;
  const H = 60;
  const paths = useMemo(() => {
    const build = (vals: (number | null)[] | undefined, pad: number, minRange: number, leaveOut?: (boolean | null)[]) => {
      if (!vals) return { line: '', area: '' };
      const usable = (i: number) => leaveOut?.[i] !== true;
      let min = Infinity;
      let max = -Infinity;
      let count = 0;
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (v === null || v === undefined || !usable(i)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        count++;
      }
      if (count < 2) return { line: '', area: '' };
      if (max - min < Math.max(minRange, 1e-6)) {
        const mid = (min + max) / 2;
        const half = Math.max(minRange, 1e-6) / 2;
        min = mid - half;
        max = mid + half;
      }
      const span = Math.max(1, to - from);
      const x = (t: number) => ((t - from) / span) * W;
      const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (H - pad * 2);
      let line = '';
      let area = '';
      let segStart: number | null = null;
      let lastX = 0;
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        const t = ts[i]!;
        if (v !== null && v !== undefined && !usable(i)) continue;
        if (v === null || v === undefined) {
          if (segStart !== null) area += `L${lastX.toFixed(1)},${H}L${segStart.toFixed(1)},${H}Z`;
          segStart = null;
          continue;
        }
        const px = x(t);
        const py = y(v);
        if (segStart === null) {
          line += `M${px.toFixed(1)},${py.toFixed(1)}`;
          area += `M${px.toFixed(1)},${py.toFixed(1)}`;
          segStart = px;
        } else {
          line += `L${px.toFixed(1)},${py.toFixed(1)}`;
          area += `L${px.toFixed(1)},${py.toFixed(1)}`;
        }
        lastX = px;
      }
      if (segStart !== null) area += `L${lastX.toFixed(1)},${H}L${segStart.toFixed(1)},${H}Z`;
      return { line, area };
    };
    return { main: build(values, 6, minSpan, skip), second: build(secondary, 10, secondaryMinSpan) };
  }, [ts, values, secondary, skip, from, to, minSpan, secondaryMinSpan]);

  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {paths.second.line && (
        <path
          d={paths.second.line}
          fill="none"
          stroke={secondaryColor}
          strokeOpacity="0.45"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
          strokeDasharray="3 3"
        />
      )}
      {paths.main.area && <path d={paths.main.area} fill={`url(#g${id})`} />}
      {paths.main.line && (
        <path d={paths.main.line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      )}
    </svg>
  );
}
