import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { History } from '@rapthooker/shared';
import { dateTime } from '../format';
import { t } from '../i18n';
import { Sparkline } from './Sparkline';
import { clampWindow, isZoomed, panWindow, resizeWindow, zoomWindow, type TimeWindow } from './chartMath';
import './Chart.css';

type Drag = { kind: 'pan' | 'from' | 'to'; startX: number; start: TimeWindow; width: number };

/**
 * The whole range in miniature under the chart, with the visible part highlighted. Drag the highlight to move along,
 * drag its ends to zoom, or tap elsewhere to jump there.
 */
export function OverviewStrip({
  history,
  bounds,
  view,
  color,
  onChange,
}: {
  history: History | null;
  bounds: TimeWindow;
  /** The visible window, or null for all of it. */
  view: TimeWindow | null;
  color: string;
  onChange: (win: TimeWindow) => void;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  const pending = useRef<TimeWindow | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => () => window.cancelAnimationFrame(raf.current), []);

  const span = Math.max(1, bounds.to - bounds.from);
  const win = view ? clampWindow(view, bounds) : bounds;
  const left = ((win.from - bounds.from) / span) * 100;
  const width = Math.max(0.5, ((win.to - win.from) / span) * 100);

  const emit = (w: TimeWindow) => {
    pending.current = w;
    if (raf.current) return;
    raf.current = window.requestAnimationFrame(() => {
      raf.current = 0;
      const next = pending.current;
      pending.current = null;
      if (next) onChangeRef.current(next);
    });
  };
  const flush = () => {
    window.cancelAnimationFrame(raf.current);
    raf.current = 0;
    if (pending.current) onChangeRef.current(pending.current);
    pending.current = null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const box = el.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const edge = (e.target as HTMLElement).dataset.edge as 'from' | 'to' | undefined;
    let start = win;
    if (!edge) {
      const t = bounds.from + ((e.clientX - box.left) / box.width) * span;
      if (t < win.from || t > win.to) {
        start = panWindow(win, t - (win.from + win.to) / 2, bounds);
        emit(start);
      }
    }
    drag.current = { kind: edge ?? 'pan', startX: e.clientX, start, width: box.width };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = ((e.clientX - d.startX) / d.width) * span;
    emit(d.kind === 'pan' ? panWindow(d.start, delta, bounds) : resizeWindow(d.start, d.kind, delta, bounds));
  };
  const onPointerEnd = () => {
    if (!drag.current) return;
    drag.current = null;
    flush();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (win.to - win.from) * 0.1;
    let next: TimeWindow | null = null;
    if (e.key === 'ArrowLeft') next = e.shiftKey ? resizeWindow(win, 'from', -step, bounds) : panWindow(win, -step, bounds);
    else if (e.key === 'ArrowRight') next = e.shiftKey ? resizeWindow(win, 'to', step, bounds) : panWindow(win, step, bounds);
    else if (e.key === '+' || e.key === '=') next = zoomWindow(win, (win.from + win.to) / 2, 0.5, bounds);
    else if (e.key === '-' || e.key === '_') next = zoomWindow(win, (win.from + win.to) / 2, 2, bounds);
    else if (e.key === 'Home') next = panWindow(win, bounds.from - win.from, bounds);
    else if (e.key === 'End') next = panWindow(win, bounds.to - win.to, bounds);
    if (!next) return;
    e.preventDefault();
    onChange(next);
  };

  const zoomed = isZoomed(win, bounds);
  return (
    <div
      ref={el}
      className={`overview${zoomed ? ' zoomed' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {history && history.ts.length > 1 ? (
        <Sparkline
          ts={history.ts}
          values={history.gravity}
          skip={history.implausible}
          secondary={history.temperature}
          color={color}
          from={bounds.from}
          to={bounds.to}
          minSpan={0.004}
          secondaryMinSpan={3}
        />
      ) : (
        <div className="sparkline" />
      )}
      <div className="overview-shade" style={{ left: 0, width: `${left}%` }} />
      <div className="overview-shade" style={{ left: `${left + width}%`, right: 0 }} />
      <div
        className="overview-window"
        style={{ left: `${left}%`, width: `${width}%` }}
        role="scrollbar"
        aria-orientation="horizontal"
        aria-label={t('Part of the range shown on the chart')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(left)}
        aria-valuetext={t('{from} to {to}', { from: dateTime(win.from), to: dateTime(win.to) })}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <span className="overview-handle" data-edge="from" aria-hidden="true" />
        <span className="overview-handle end" data-edge="to" aria-hidden="true" />
      </div>
    </div>
  );
}
