// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiToken } from '@rapthooker/shared';

const live = vi.hoisted(() => ({ isOwner: true, toast: vi.fn() }));
vi.mock('../../live', () => ({ useLive: () => live }));

import { TokensSection } from './TokensSection';

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

describe('TokensSection', () => {
  let tokens: ApiToken[];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/tokens' && method === 'GET') return json(tokens);
    if (url === '/api/tokens' && method === 'POST') {
      const { name, scope } = JSON.parse(String(init?.body)) as Pick<ApiToken, 'name' | 'scope'>;
      const token: ApiToken = { id: 't1', name, scope, hint: '1234', createdAt: Date.now(), lastUsedAt: null };
      tokens = [token];
      return json({ ...token, token: `rh_${scope}_secretvalue1234` });
    }
    if (url === '/api/tokens/t1' && method === 'DELETE') {
      tokens = [];
      return new Response(null, { status: 204 });
    }
    return new Response('{"error":"nope"}', { status: 404 });
  });

  beforeEach(() => {
    tokens = [];
    live.isOwner = true;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('creates a token, shows it once, and deletes it', async () => {
    render(createElement(TokensSection));
    await screen.findByText('No tokens yet.');
    fireEvent.change(screen.getByPlaceholderText(/Grafana/), { target: { value: 'Grafana' } });
    fireEvent.click(screen.getByRole('button', { name: /Create token/ }));

    await screen.findByText('rh_read_secretvalue1234');
    expect(screen.getByText(/won't be shown again/)).toBeTruthy();
    expect(screen.getByText(/curl -H "Authorization: Bearer rh_read_secretvalue1234"/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('rh_read_secretvalue1234')).toBeNull();
    await screen.findByText('rh_read_…1234');
    expect(screen.getByText(/never used/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Grafana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('rh_read_…1234')).toBeNull());
  });

  it('explains the relay scope and needs a name', async () => {
    render(createElement(TokensSection));
    await screen.findByText('No tokens yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Relay' }));
    expect(screen.getByText(/passes on what it hears/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Create token/ }));
    await waitFor(() => expect(live.toast).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('is for the owner only', () => {
    live.isOwner = false;
    render(createElement(TokensSection));
    expect(screen.getByText(/Sign in with the owner PIN/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
