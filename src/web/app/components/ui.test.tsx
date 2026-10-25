// @vitest-environment happy-dom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Confirm, Modal } from './ui';

afterEach(cleanup);

/** A card that opens a dialog, like the pages do. */
function Card({ nested = false, onClose = () => undefined }: { nested?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <section className="panel" data-testid="card">
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Modal
          title="Outer"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <input aria-label="Name" />
          {nested && (
            <button type="button" onClick={() => setInner(true)}>
              Delete
            </button>
          )}
          {inner && <Confirm title="Sure?" body="Really." confirm="Yes" onConfirm={() => undefined} onClose={() => setInner(false)} />}
        </Modal>
      )}
    </section>
  );
}

describe('Modal', () => {
  it('renders into <body>, outside the card that opened it', () => {
    render(<Card />);
    fireEvent.click(screen.getByText('Open'));
    const dialog = screen.getByRole('dialog', { name: 'Outer' });
    expect(screen.getByTestId('card').contains(dialog)).toBe(false);
    expect(dialog.closest('.modal-backdrop')?.parentElement).toBe(document.body);
  });

  it('moves focus in on open and back to the button that opened it on close', () => {
    render(<Card />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the dialog', () => {
    render(<Card />);
    fireEvent.click(screen.getByText('Open'));
    const dialog = screen.getByRole('dialog');
    const close = screen.getByLabelText('Close');
    const name = screen.getByLabelText('Name');
    // happy-dom has no layout, so every control counts as visible.
    for (const el of [close, name]) Object.defineProperty(el, 'offsetParent', { get: () => document.body });
    name.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(name);
  });

  it('closes only the top dialog on Escape', () => {
    const outerClosed = vi.fn();
    render(<Card nested onClose={outerClosed} />);
    fireEvent.click(screen.getByText('Open'));
    const del = screen.getByText('Delete');
    del.focus();
    fireEvent.click(del);
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(outerClosed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(del);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(outerClosed).toHaveBeenCalledOnce();
  });

  it('closes when the backdrop is clicked, not the dialog', () => {
    render(<Card />);
    fireEvent.click(screen.getByText('Open'));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.mouseDown(document.querySelector('.modal-backdrop')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
