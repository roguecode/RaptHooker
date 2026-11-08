// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import { keepTappedValues } from './tapCursor';

const releases: (() => void)[] = [];
afterEach(() => {
  releases.splice(0).forEach((r) => r());
  document.body.innerHTML = '';
});

/** Enough of uPlot: its plot hides the values when the mouse leaves it. */
function plot() {
  const root = document.createElement('div');
  const over = document.createElement('div');
  root.append(over);
  const outside = document.createElement('button');
  document.body.append(root, outside);
  const cursor = { left: -10 };
  const setCursor = vi.fn((c: { left: number }) => (cursor.left = c.left));
  const left = vi.fn(() => (cursor.left = -10));
  over.addEventListener('mouseleave', left);
  releases.push(keepTappedValues({ root, over, cursor, setCursor } as unknown as uPlot));
  return { over, outside, cursor, setCursor, left };
}

const pointer = (type: string, pointerType: string) => new PointerEvent(type, { bubbles: true, pointerType });

describe('keepTappedValues', () => {
  it("keeps a tap's values when the browser says the mouse left, until a tap elsewhere", () => {
    const p = plot();
    p.over.dispatchEvent(pointer('pointerdown', 'touch'));
    p.cursor.left = 120;
    p.over.dispatchEvent(new MouseEvent('mouseleave'));
    expect(p.left).not.toHaveBeenCalled();
    expect(p.cursor.left).toBe(120);

    p.over.dispatchEvent(pointer('pointerdown', 'touch'));
    expect(p.setCursor).not.toHaveBeenCalled();
    p.outside.dispatchEvent(pointer('pointerdown', 'touch'));
    expect(p.setCursor).toHaveBeenCalledWith({ left: -10, top: -10 });
    expect(p.cursor.left).toBe(-10);
  });

  it('leaves a mouse alone', () => {
    const p = plot();
    p.over.dispatchEvent(pointer('pointerdown', 'touch'));
    p.over.dispatchEvent(pointer('pointermove', 'mouse'));
    p.cursor.left = 120;
    p.over.dispatchEvent(new MouseEvent('mouseleave'));
    expect(p.left).toHaveBeenCalledOnce();
    p.cursor.left = 120;
    p.outside.dispatchEvent(pointer('pointerdown', 'mouse'));
    expect(p.setCursor).not.toHaveBeenCalled();
  });
});
