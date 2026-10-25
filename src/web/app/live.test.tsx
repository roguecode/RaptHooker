// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeSession, renderWithHub } from './test/render';
import { useLive } from './live';

function Who() {
  const { session, isOwner } = useLive();
  return <p data-testid="who">{session ? (isOwner ? 'owner' : 'viewer') : 'nobody'}</p>;
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
});
