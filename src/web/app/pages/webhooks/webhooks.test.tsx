// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WEBHOOK_OPTIONS, PRESETS, type Webhook } from '@rapthooker/shared';

const live = vi.hoisted(() => ({ isOwner: true, toast: vi.fn(), pills: [] as object[], hub: { name: 'RaptHooker' } }));
vi.mock('../../live', () => ({ useLive: () => live, useLiveMessages: () => undefined }));

import { PresetGrid } from './PresetGrid';
import { Preview } from './Preview';
import { WebhookEditor } from './WebhookEditor';
import { WebhooksPage } from './WebhooksPage';

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

const pill = (id: string, name: string) => ({ id, name, kind: 'pill', color: '#a78bfa', archived: false, live: { latest: null } });
const radio = (name: RegExp) => screen.getByRole('radio', { name }) as HTMLInputElement;
const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

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
    live.pills = [];
    live.toast.mockClear();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('marks the services tried for real as verified and the others as untested', () => {
    render(createElement(PresetGrid, { onPick: () => undefined }));
    expect(PRESETS.filter((p) => p.verified).map((p) => p.name)).toEqual([
      'Grainfather',
      'BrewSpy',
      'MeadTools',
      'Home Assistant',
      'Discord',
    ]);
    expect(screen.getAllByText('Verified')).toHaveLength(5);
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

  it('gives a service that tells pills apart all of them, and one that cannot a single pill', () => {
    expect(PRESETS.filter((p) => p.onePillPerWebhook).map((p) => p.name)).toEqual(['Grainfather', 'BrewSpy', 'ThingSpeak']);
    live.pills = [pill('p1', 'Kveik'), pill('p2', 'Lager')];
    render(createElement(WebhookEditor, { id: null }));
    fireEvent.click(screen.getByRole('button', { name: /Brewfather/ }));
    expect(radio(/^All pills/).checked).toBe(true);
    expect(screen.queryByText('One pill per webhook')).toBeNull();
  });

  it('asks for one pill for Grainfather, unless the owner allows several anyway', () => {
    live.pills = [pill('p1', 'Kveik'), pill('p2', 'Lager')];
    render(createElement(WebhookEditor, { id: null }));
    fireEvent.click(screen.getByRole('button', { name: /Grainfather/ }));

    expect(screen.getByRole('alert').textContent).toMatch(
      /One pill per webhook.*Grainfather files everything a webhook sends under one device/,
    );
    expect(radio(/^All pills/).disabled).toBe(true);
    expect(screen.getByText('Not for Grainfather: it takes one pill per webhook.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Create webhook/ }));
    expect(screen.getByText('Choose one pill')).toBeTruthy();
    expect(live.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', title: "Couldn't save" }));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Kveik' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lager' }));
    expect([pressed('Kveik'), pressed('Lager')]).toEqual(['false', 'true']);
    expect(screen.queryByText('Choose one pill')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Allow several pills anyway' }));
    expect(radio(/^All pills/).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Kveik' }));
    expect([pressed('Kveik'), pressed('Lager')]).toEqual(['true', 'true']);
    expect(screen.getByRole('alert').textContent).toMatch(/Several pills on one Grainfather device/);

    fireEvent.click(screen.getByRole('button', { name: 'Back to one pill' }));
    // Keeps the pill chosen first.
    expect([pressed('Kveik'), pressed('Lager')]).toEqual(['false', 'true']);
    expect(radio(/^All pills/).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/One pill per webhook/);
  });

  it('starts a one-pill service with the only pill, leaving out thermometers', () => {
    live.pills = [pill('p1', 'Kveik'), { ...pill('t1', 'Fridge'), kind: 'thermometer' }];
    render(createElement(WebhookEditor, { id: null }));
    fireEvent.click(screen.getByRole('button', { name: /BrewSpy/ }));
    expect([pressed('Kveik'), pressed('Fridge')]).toEqual(['true', 'false']);
  });

  it('flags a saved webhook that sends several pills to one Grainfather device, and opens it as allowed', async () => {
    hooks = [webhook({ name: 'Grainfather', preset: 'grainfather', url: 'http://community.grainfather.com/iot/abc/ispindel' })];
    live.pills = [pill('p1', 'Kveik')];
    render(createElement(WebhooksPage));
    expect(await screen.findByText('Several pills on one Grainfather device')).toBeTruthy();
    cleanup();

    render(createElement(WebhookEditor, { id: 'w1' }));
    await screen.findByRole('heading', { name: 'Edit webhook' });
    expect(screen.getByRole('alert').textContent).toMatch(/Several pills on one Grainfather device/);
    expect(radio(/^All pills/).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Back to one pill' }));
    expect(pressed('Kveik')).toBe('true');
    expect(radio(/^All pills/).disabled).toBe(true);
  });

  it("doesn't flag a webhook to a service that tells pills apart", async () => {
    render(createElement(WebhooksPage));
    await screen.findByRole('heading', { name: 'Brewfather' });
    expect(screen.queryByText(/Several pills on one/)).toBeNull();
  });

  const batchBox = () => screen.queryByRole('checkbox', { name: /^Send all pills in one request/ }) as HTMLInputElement | null;

  it('offers one request for all pills only to services that can take one', () => {
    expect(PRESETS.filter((p) => !p.oneReadingPerRequest).map((p) => p.id)).toEqual(['homeassistant', 'discord', 'generic', 'custom']);
    live.pills = [pill('p1', 'Kveik'), pill('p2', 'Lager')];
    render(createElement(WebhookEditor, { id: null }));
    fireEvent.click(screen.getByRole('button', { name: /MeadTools/ }));
    // One token takes every pill, each in its own request.
    expect(radio(/^All pills/).checked).toBe(true);
    expect(batchBox()).toBeNull();
    expect(screen.getByText('MeadTools takes one reading per request, so each pill is sent on its own.')).toBeTruthy();
    cleanup();

    render(createElement(WebhookEditor, { id: null }));
    fireEvent.click(screen.getByRole('button', { name: /Home Assistant/ }));
    expect(batchBox()!.checked).toBe(false);
    expect(screen.queryByText(/takes one reading per request/)).toBeNull();
  });

  it('warns about a saved webhook sending all pills in one request to such a service, and lets it be switched off', async () => {
    const batch = { batch: true, batchBody: '{"readings": [{{items}}]}' };
    hooks = [
      webhook({ name: 'MeadTools', preset: 'meadtools', url: 'https://meadtools.com/api/hydrometer/rapt-pill', ...batch }),
      webhook({ id: 'w2', name: 'Home Assistant', preset: 'homeassistant', url: 'http://ha:8123/api/webhook/x', ...batch }),
    ];
    render(createElement(WebhooksPage));
    await screen.findByRole('heading', { name: 'MeadTools' });
    const chips = screen.getAllByText('One request for all');
    expect(chips.map((c) => c.className)).toEqual(['chip warning', 'chip']);
    expect(chips[0]!.getAttribute('title')).toMatch(/^MeadTools takes one reading per request, so it can't use all pills sent together/);
    cleanup();

    render(createElement(WebhookEditor, { id: 'w1' }));
    await screen.findByRole('heading', { name: 'Edit webhook' });
    expect(batchBox()!.checked).toBe(true);
    expect(screen.getByText(/^MeadTools takes one reading per request, so it can't use all pills sent together/)).toBeTruthy();
    fireEvent.click(batchBox()!);
    expect(batchBox()).toBeNull();
    expect(screen.getByText('MeadTools takes one reading per request, so each pill is sent on its own.')).toBeTruthy();
  });
});
