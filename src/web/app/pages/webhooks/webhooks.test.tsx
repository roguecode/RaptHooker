// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WEBHOOK_OPTIONS, PRESETS, type Webhook } from '@rapthooker/shared';

const live = vi.hoisted(() => ({ isOwner: true, toast: vi.fn(), pills: [], hub: { name: 'RaptHooker' } }));
vi.mock('../../live', () => ({ useLive: () => live, useLiveMessages: () => undefined }));

import { PresetGrid } from './PresetGrid';
import { Preview } from './Preview';
import { WebhooksPage } from './WebhooksPage';

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

const webhook = (over: Partial<Webhook> = {}): Webhook => ({
  name: 'Brewfather',
  enabled: true,
  preset: 'brewfather',
  url: 'https://log.brewfather.net/stream?id=abc',
  method: 'POST',
  headers: [],
  bodyFormat: 'json',
  body: '{}',
  intervalMin: 15,
  pillIds: 'all',
  onlyDuringBrew: false,
  onlyNewReadings: true,
  gravityUnit: 'sg',
  temperatureUnit: 'C',
  timeoutSec: 15,
  ...DEFAULT_WEBHOOK_OPTIONS,
  id: 'w1',
  createdAt: 0,
  updatedAt: 0,
  masked: false,
  status: { lastAt: null, lastOk: null, lastHttpStatus: null, lastError: null, sent24h: 0, failed24h: 0, pills: [] },
  ...over,
});

describe('webhooks UI', () => {
  let hooks: Webhook[];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/webhooks' && method === 'GET') return json(hooks);
    if (url === '/api/webhooks/w1/pause') {
      const { until } = JSON.parse(String(init?.body)) as { until: number | null };
      hooks = [{ ...hooks[0]!, pausedUntil: until }];
      return json(hooks[0]);
    }
    if (url === '/api/webhooks/w1/duplicate') return json(webhook({ id: 'w2', name: 'Brewfather (copy)', enabled: false }));
    return new Response('{"error":"nope"}', { status: 404 });
  });

  beforeEach(() => {
    hooks = [webhook()];
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('marks the services tried for real as verified and the others as untested', () => {
    render(createElement(PresetGrid, { onPick: () => undefined }));
    expect(PRESETS.filter((p) => p.verified).map((p) => p.name)).toEqual(['Grainfather', 'BrewSpy', 'Home Assistant', 'Discord']);
    expect(screen.getAllByText('Verified')).toHaveLength(4);
    const services = PRESETS.filter((p) => p.docsUrl !== null && !p.verified).length;
    expect(screen.getAllByText('Untested')).toHaveLength(services + 1);
    expect(screen.getAllByText('Untested')[0]!.getAttribute('title')).toMatch(/not yet tried against the real service/);
  });

  it('pauses until resumed, then resumes', async () => {
    render(createElement(WebhooksPage));
    fireEvent.click(await screen.findByRole('button', { name: /Pause/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Until I resume it' }));
    await screen.findByText(/Paused until you resume it/);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body)).until).toBeGreaterThan(Date.UTC(9000, 0, 1));

    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    await waitFor(() => expect(screen.queryByText(/Paused until/)).toBeNull());
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toEqual({ until: null });
  });

  it('duplicates, and shows why readings are held back', async () => {
    hooks = [
      webhook({
        status: {
          ...webhook().status,
          pills: [{ pillId: 'p1', lastSentAt: null, lastOk: null, nextAt: null, skipped: 'Not sent: the latest reading looks wrong' }],
        },
      }),
    ];
    render(createElement(WebhooksPage));
    await screen.findByText(/removed pill: Not sent: the latest reading looks wrong/);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await screen.findByText('Brewfather (copy)');
  });

  it('warns that an export contains secrets', async () => {
    render(createElement(WebhooksPage));
    fireEvent.click(await screen.findByRole('button', { name: /Export/ }));
    expect(screen.getByText(/including API keys and tokens/)).toBeTruthy();
  });

  it('previews a batch request', () => {
    const draft = {
      ...webhook(),
      batch: true,
      body: '{"name": "{{name}}"}',
      batchBody: '{"readings": [{{items}}], "hub": "{{hub_name}}"}',
    };
    render(createElement(Preview, { draft, webhookId: null, canSend: () => true }));
    expect(screen.getByText(/"name": "Sample Pill"/)).toBeTruthy();
    expect(screen.getByText(/"hub": "RaptHooker"/)).toBeTruthy();
    expect(screen.getByText(/Sends every chosen pill/)).toBeTruthy();
  });
});
