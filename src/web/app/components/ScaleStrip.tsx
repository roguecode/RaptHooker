import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { t } from '../i18n';
import { clampWindow, panWindow, resizeWindow, zoomWindow, type TimeWindow } from './chartMath';
import './Chart.css';

type Drag = {
  kind: 'pan' | 'from' | 'to';
  startY: number;
  /** The range when the pointer went down, and where the drag started from (moved there if tapped outside it). */
  origin: TimeWindow;
  start: TimeWindow;
  last: TimeWindow;
  height: number;
  moved: boolean;
};

/** Smallest range the selector allows, as a share of its track (room for both grips). */
const MIN_SHARE = 1 / 20;

export interface ScaleStripProps {
  /** The line it scales, e.g. "Temperature". */
  name: string;
  color: string;
  /** Everything the selector covers, bottom to top. */
  track: TimeWindow;
  /** The scale's range now. */
  value: TimeWindow;
  /** Set by the user; otherwise the scale follows the readings in view. */
  custom: boolean;
  /** CSS px within the chart. */
  left: number;
  top: number;
  height: number;
  format: (v: number) => string;
  /** While the range is dragged (`done` false), and once it's let go or changed with the keyboard. */
  onChange: (range: TimeWindow, done: boolean) => void;
  /** A drag ended where it started. */
  onCancel: () => void;
  /** Back to scaling itself: double-click, double-tap or 0. */
  onReset: () => void;
}

/**
 * A scale's range beside its numbers, like the overview strip under the chart but upright: drag the highlight to move
 * the range up or down, drag its ends to stretch it, tap elsewhere to move it there.
 */
export function ScaleStrip({ name, color, track, value, custom, left, top, height, format, onChange, onCancel, onReset }: ScaleStripProps) {
  const el = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  const pending = useRef<TimeWindow | null>(null);
  const lastTap = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => () => window.cancelAnimationFrame(raf.current), []);

  const span = Math.max(Number.EPSILON, track.to - track.from);
  const minSpan = span * MIN_SHARE;
  const win = clampWindow(value, track, minSpan);
  const topPct = ((track.to - win.to) / span) * 100;
  const heightPct = ((win.to - win.from) / span) * 100;

  const emit = (w: TimeWindow) => {
    pending.current = w;
    if (raf.current) return;
    raf.current = window.requestAnimationFrame(() => {
      raf.current = 0;
      const next = pending.current;
      pending.current = null;
      if (next) onChangeRef.current(next, false);
    });
  };
  const finish = (w: TimeWindow | null) => {
    window.cancelAnimationFrame(raf.current);
    raf.current = 0;
    pending.current = null;
    if (w) onChangeRef.current(w, true);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const box = el.current?.getBoundingClientRect();
    if (!box || box.height <= 0) return;
    const edge = (e.target as HTMLElement).dataset.edge as 'from' | 'to' | undefined;
    let start = win;
    let moved = false;
    if (!edge) {
      const v = track.to - ((e.clientY - box.top) / box.height) * span;
      if (v < win.from || v > win.to) {
        start = panWindow(win, v - (win.from + win.to) / 2, track);
        moved = true;
        emit(start);
      }
    }
    drag.current = { kind: edge ?? 'pan', startY: e.clientY, origin: win, start, last: start, height: box.height, moved };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dy) < 3) return;
    d.moved = true;
    const delta = (-dy / d.height) * span;
    d.last = d.kind === 'pan' ? panWindow(d.start, delta, track) : resizeWindow(d.start, d.kind, delta, track, minSpan);
    emit(d.last);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const eps = span * 1e-6;
    const changed = Math.abs(d.last.from - d.origin.from) > eps || Math.abs(d.last.to - d.origin.to) > eps;
    finish(d.moved && changed ? d.last : null);
    if (d.moved && !changed) onCancel();
    // Touch screens: a double tap goes back to automatic (a mouse has dblclick).
    if (e.type !== 'pointerup' || e.pointerType === 'mouse') return;
    const now = performance.now();
    if (!d.moved && now - lastTap.current < 350) {
      lastTap.current = 0;
      onReset();
    } else lastTap.current = d.moved ? 0 : now;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = (win.to - win.from) * 0.1;
    const mid = (win.from + win.to) / 2;
    let next: TimeWindow | null = null;
    if (e.key === 'ArrowUp') next = e.shiftKey ? resizeWindow(win, 'to', step, track, minSpan) : panWindow(win, step, track);
    else if (e.key === 'ArrowDown') next = e.shiftKey ? resizeWindow(win, 'from', -step, track, minSpan) : panWindow(win, -step, track);
    else if (e.key === '+' || e.key === '=') next = zoomWindow(win, mid, 0.5, track, minSpan);
    else if (e.key === '-' || e.key === '_') next = zoomWindow(win, mid, 2, track, minSpan);
    else if (e.key === '0') {
      e.preventDefault();
      e.stopPropagation();
      onReset();
      return;
    }
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(next, true);
  };

  const range = t('{from} to {to}', { from: format(win.from), to: format(win.to) });
  return (
    <div
      ref={el}
      className={`scale-strip${custom ? ' custom' : ''}`}
      style={{ left, top, height, '--strip': color } as CSSProperties}
      title={t('{name}: drag to set the scale, double-click to scale it automatically', { name })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onReset}
    >
      <div
        className="scale-strip-window"
        style={{ top: `${topPct}%`, height: `${heightPct}%` }}
        role="scrollbar"
        aria-orientation="vertical"
        aria-label={t('{name} scale', { name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(topPct)}
        aria-valuetext={custom ? range : t('{range} (automatic)', { range })}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <span className="scale-strip-handle" data-edge="to" aria-hidden="true" />
        <span className="scale-strip-handle end" data-edge="from" aria-hidden="true" />
      </div>
    </div>
  );
}
