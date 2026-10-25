import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { Pill } from '@rapthooker/shared';
import { dropIndex, moveBy, moveItem } from '../../order';
import { Icon } from '../../components/Icon';
import { PillFigure } from '../../components/PillFigure';
import { t } from '../../i18n';

interface Drag {
  id: string;
  pointerId: number;
  startY: number;
  /** Where the row sat when the drag started. */
  startTop: number;
  lastY: number;
  moved: boolean;
}

/**
 * The pills as a list to put in order: drag a row (by its handle on touch screens), or use the arrow buttons.
 * `onChange` gets each new order; `final` is false while a drag is still going.
 */
export function ArrangeList({ pills, onChange }: { pills: Pill[]; onChange: (ids: string[], final: boolean) => void }) {
  const ids = pills.map((p) => p.id);
  const list = useRef<HTMLOListElement | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [said, setSaid] = useState('');

  /** Keeps the dragged row under the pointer, wherever the list has put it. Returns its box at rest. */
  const follow = () => {
    const d = drag.current;
    const el = d && rows.current.get(d.id);
    if (!d || !el) return null;
    el.style.transform = '';
    const rest = el.getBoundingClientRect();
    const offset = d.lastY - d.startY - (rest.top - d.startTop);
    el.style.transform = `translateY(${offset}px)`;
    return { rest, offset };
  };

  // After the list re-orders mid-drag, the row moves in the layout: put it back under the pointer straight away.
  useLayoutEffect(() => {
    follow();
  });

  const announce = (id: string, order: string[]) => {
    const name = pills.find((p) => p.id === id)?.name ?? t('Pill');
    setSaid(t('{name} moved to position {n} of {total}.', { name, n: order.indexOf(id) + 1, total: order.length }));
  };

  const end = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    const el = rows.current.get(d.id);
    if (el) el.style.transform = '';
    drag.current = null;
    setDragging(null);
    if (list.current?.hasPointerCapture(d.pointerId)) list.current.releasePointerCapture(d.pointerId);
    if (commit && d.moved) {
      onChange(ids, true);
      announce(d.id, ids);
    }
  };

  const onPointerDown = (e: ReactPointerEvent, id: string) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || drag.current || target.closest('button')) return;
    // On touch screens only the handle drags, so the list can still be scrolled.
    if (e.pointerType !== 'mouse' && !target.closest('.drag-handle')) return;
    const el = rows.current.get(id);
    if (!el || !list.current) return;
    e.preventDefault();
    list.current.setPointerCapture(e.pointerId);
    drag.current = {
      id,
      pointerId: e.pointerId,
      startY: e.clientY,
      startTop: el.getBoundingClientRect().top,
      lastY: e.clientY,
      moved: false,
    };
    setDragging(id);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.lastY = e.clientY;
    const pos = follow();
    if (!pos) return;
    const middle = pos.rest.top + pos.offset + pos.rest.height / 2;
    const others = ids.filter((x) => x !== d.id);
    const middles = others.map((x) => {
      const r = rows.current.get(x)?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : 0;
    });
    const from = ids.indexOf(d.id);
    const to = dropIndex(middles, middle);
    if (to !== from) {
      d.moved = true;
      onChange(moveItem(ids, from, to), false);
    }
  };

  const move = (id: string, delta: number) => {
    const next = moveBy(ids, id, delta);
    if (next.every((x, i) => x === ids[i])) return;
    onChange(next, true);
    announce(id, next);
  };

  return (
    <>
      <ol
        ref={list}
        className={`arrange-list${dragging ? ' dragging' : ''}`}
        aria-label={t('Pill order')}
        onPointerMove={onPointerMove}
        onPointerUp={() => end(true)}
        onPointerCancel={() => end(true)}
        onLostPointerCapture={() => end(true)}
      >
        {pills.map((p, i) => (
          <li
            key={p.id}
            ref={(el) => {
              if (el) rows.current.set(p.id, el);
              else rows.current.delete(p.id);
            }}
            className={`arrange-row${dragging === p.id ? ' lifted' : ''}`}
            style={{ '--pill': p.color } as CSSProperties}
            onPointerDown={(e) => onPointerDown(e, p.id)}
          >
            <span className="drag-handle" aria-hidden="true" title={t('Drag to move')}>
              <Icon name="grip" size={18} />
            </span>
            <PillFigure color={p.color} tilt={p.live.latest?.tilt} size={34} offline={!p.live.online} decorative />
            <div className="grow">
              <strong>{p.name}</strong>
              <span className="small muted">
                {t('{n} of {total}', { n: i + 1, total: pills.length })}
                {p.brew ? ` · ${p.brew.name}` : ''}
              </span>
            </div>
            <button
              type="button"
              className="btn icon small"
              aria-label={t('Move {name} up', { name: p.name })}
              title={t('Move up')}
              aria-disabled={i === 0}
              onClick={() => move(p.id, -1)}
            >
              <Icon name="arrowUp" size={16} />
            </button>
            <button
              type="button"
              className="btn icon small"
              aria-label={t('Move {name} down', { name: p.name })}
              title={t('Move down')}
              aria-disabled={i === pills.length - 1}
              onClick={() => move(p.id, 1)}
            >
              <Icon name="arrowDown" size={16} />
            </button>
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </>
  );
}
