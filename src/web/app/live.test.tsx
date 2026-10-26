// @vitest-environment happy-dom
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeSession, renderWithHub, settle } from './test/render';
import { useLive } from './live';

function Who() {
  const { session, isOwner } = useLive();
  return <p data-testid="who">{session ? (isOwner ? 'owner' : 'viewer') : 'nobody'}</p>;
}

function Connection() {
  const { connection, setSession } = useLive();
  return (
    <>
      <p data-testid="connection">{connection}</p>
      <button type="button" onClick={() => setSession(makeSession({ role: 'viewer' }))}>
        Sign out
      </button>
    </>
  );
}

describe('LiveProvider', () => {
  it('asks who is signed in again when the hub answers, if the first try failed', async () => {
    let tries = 0;
    const view = await renderWithHub(<Who />, {
      routes: {
        'GET /api/session': () => {
          if (++tries === 1) throw new TypeError('Failed to fetch');
          return makeSession();
        },
      },
    });
    expect(screen.getByTestId('who').textContent).toBe('owner');
    expect(view.calls('GET /api/session')).toHaveLength(2);

    // Not on every reconnect, though.
    await view.reconnect();
    expect(view.calls('GET /api/session')).toHaveLength(2);
  });

  it("isn't put off by the old connection closing after it reconnects for someone else", async () => {
    await renderWithHub(<Connection />);
    expect(screen.getByTestId('connection').textContent).toBe('open');
    // Browsers say a socket has closed a moment later, when the next one is already connecting or open.
    const proto = (window.WebSocket as unknown as { prototype: { close(): void } }).prototype;
    const close = proto.close;
    proto.close = function (this: unknown) {
      setTimeout(() => close.call(this), 20);
    };
    try {
      fireEvent.click(screen.getByText('Sign out'));
      await settle();
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(screen.getByTestId('connection').textContent).toBe('open');
    } finally {
      proto.close = close;
    }
  });
});
