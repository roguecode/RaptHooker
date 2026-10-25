import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from '@rapthooker/shared';
import { Settings } from '../settings.js';
import {
  LATEST_RELEASE_API,
  REQUEST_FILE,
  STATUS_FILE,
  UpdateError,
  UpdateService,
  compareVersions,
  isNewer,
  type UpdateOptions,
} from '../updates.js';
import { updateRoutes } from '../routes/updates.js';
import type { RouteContext } from '../routes/context.js';
import type { Store } from '../db.js';
import { silent, tempStore } from './helpers.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: tag,
  body: `## What's new in ${tag}\n\n- Things`,
  html_url: `https://github.com/roguecode/RaptHooker/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
});

let t: ReturnType<typeof tempStore>;
let services: UpdateService[] = [];
beforeEach(() => {
  t = tempStore();
  services = [];
});
afterEach(() => {
  for (const s of services) s.stop();
  vi.useRealTimers();
  t.cleanup();
});

function make(opts: UpdateOptions & { version?: string; store?: Store } = {}) {
  const settings = new Settings(t.store);
  const service = new UpdateService(opts.version ?? '0.2.0', settings, silent, {
    dataDir: t.dir,
    store: t.store,
    installMarker: join(t.dir, '.installer'),
    pathUnit: join(t.dir, 'rapthooker-update.path'),
    ...opts,
  });
  services.push(service);
  return { service, settings };
}

/** What setup.d/40-updates.sh and the app's files leave behind: the updater's unit, and the installer it runs. */
function updater(dataDir = t.dir) {
  mkdirSync(join(t.dir, 'deploy'), { recursive: true });
  writeFileSync(join(t.dir, 'deploy', 'install.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(t.dir, 'rapthooker-update.path'), `[Path]\nPathExists=${join(dataDir, REQUEST_FILE)}\n`);
}

/** What install.sh and setup.d/40-updates.sh leave behind. */
function installed(dataDir = t.dir) {
  writeFileSync(join(t.dir, '.installer'), 'version=0.2.0\n');
  updater(dataDir);
}

/** What deploy.ps1 / deploy.sh leave behind. */
function devDeployed() {
  writeFileSync(join(t.dir, '.dev-build'), 'deployed from source by deploy.ps1, not a release\n');
  updater();
}

const BUILD = { commit: 'abc1234', changes: true, builtAt: 1_700_000_000_000 };

describe('compareVersions', () => {
  it('orders versions the semver way', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.0.0-2', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.9')).toBe(1);
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0-dev', '0.2.0')).toBe(-1);
  });

  it("returns null for things that aren't versions", () => {
    expect(compareVersions('latest', '1.0.0')).toBeNull();
    expect(compareVersions('1.0', '1.0.0')).toBeNull();
    expect(isNewer('nonsense', '0.1.0')).toBe(false);
  });
});

describe('UpdateService.check', () => {
  it('finds a newer release and asks GitHub politely', async () => {
    const fetch = vi.fn(async () => json(release('v0.3.0')));
    const { service } = make({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => 1000 });
    const events: UpdateInfo[] = [];
    service.on('update', (u: UpdateInfo) => events.push(u));

    const info = await service.check();
    expect(info).toMatchObject({
      current: '0.2.0',
      latest: '0.3.0',
      available: true,
      url: 'https://github.com/roguecode/RaptHooker/releases/tag/v0.3.0',
      checkedAt: 1000,
      error: null,
      state: 'idle',
      canSelfUpdate: false,
    });
    expect(info.notes).toContain("What's new in v0.3.0");
    expect(events).toHaveLength(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LATEST_RELEASE_API);
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/^RaptHooker\/0\.2\.0/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('offers nothing for the same or an older release', async () => {
    for (const tag of ['v0.2.0', 'v0.1.0']) {
      const { service } = make({ fetch: (async () => json(release(tag))) as typeof fetch });
      const info = await service.check();
      expect(info.available).toBe(false);
      expect(info.latest).toBe(tag.slice(1));
    }
  });

  it('ignores drafts and pre-releases', async () => {
    for (const r of [release('v0.3.0-beta.1', { prerelease: true }), release('v0.3.0', { draft: true }), release('v0.3.0-rc.1')]) {
      const { service } = make({ fetch: (async () => json(r)) as typeof fetch });
      const info = await service.check();
      expect(info.available).toBe(false);
      expect(info.latest).toBeNull();
      expect(info.error).toBeNull();
    }
  });

  it('copes with no releases at all', async () => {
    const { service } = make({ fetch: (async () => json({ message: 'Not Found' }, 404)) as typeof fetch });
    expect(await service.check()).toMatchObject({ latest: null, available: false, error: null });
  });

  it('keeps what it knew when rate limited or offline', async () => {
    let answer: () => Promise<Response> = async () => json(release('v0.3.0'));
    const { service } = make({ fetch: (() => answer()) as typeof fetch });
    await service.check();

    answer = async () =>
      json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Date.now() / 1000 + 600),
      });
    let info = await service.check();
    expect(info).toMatchObject({ latest: '0.3.0', available: true });
    expect(info.error).toMatch(/limiting/);

    answer = async () => {
      throw new TypeError('fetch failed');
    };
    info = await service.check();
    expect(info).toMatchObject({ latest: '0.3.0', available: true });
    expect(info.error).toMatch(/Couldn't reach GitHub/);

    answer = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    info = await service.check();
    expect(info.error).toMatch(/in time/);

    answer = async () => json(release('v0.3.0'));
    expect((await service.check()).error).toBeNull();
  });

  it('asks only once when checks overlap', async () => {
    const fetch = vi.fn(async () => json(release('v0.3.0')));
    const { service } = make({ fetch: fetch as unknown as typeof globalThis.fetch });
    await Promise.all([service.check(), service.check(), service.check()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('"check now" right after a check reuses the answer', async () => {
    const fetch = vi.fn(async () => json(release('v0.3.0')));
    let now = 1_000_000;
    const { service } = make({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => now });
    await service.checkNow();
    now += 10_000;
    await service.checkNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 60_000;
    await service.checkNow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('UpdateService schedule', () => {
  it('checks a minute after starting, then daily', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => json(release('v0.3.0')));
    const { service } = make({ fetch: fetch as unknown as typeof globalThis.fetch });
    service.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("remembers the last check, so a restart doesn't ask again straight away", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => json(release('v0.3.0')));
    const first = make({ fetch: fetch as unknown as typeof globalThis.fetch });
    await first.service.check();
    first.service.stop();

    const second = make({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect(second.service.info()).toMatchObject({ latest: '0.3.0', available: true });
    second.service.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a newer hub works out "available" again from what was saved', async () => {
    const first = make({ fetch: (async () => json(release('v0.3.0'))) as typeof fetch });
    await first.service.check();
    const updated = make({ version: '0.3.0' });
    expect(updated.service.info()).toMatchObject({ current: '0.3.0', latest: '0.3.0', available: false });
  });

  it("doesn't check when the owner turned it off", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => json(release('v0.3.0')));
    const { service, settings } = make({ fetch: fetch as unknown as typeof globalThis.fetch });
    settings.setHub({ ...settings.hub(), updateCheck: false });
    service.start();
    await vi.advanceTimersByTimeAsync(3 * 24 * 3_600_000);
    expect(fetch).not.toHaveBeenCalled();

    settings.setHub({ ...settings.hub(), updateCheck: true });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateService self-update', () => {
  it('can update itself only when installed with the installer and the updater unit watches its data folder', () => {
    expect(make().service.info().canSelfUpdate).toBe(false);
    writeFileSync(join(t.dir, '.installer'), 'version=0.2.0\n');
    expect(make().service.info().canSelfUpdate).toBe(false);
    installed(join(t.dir, 'elsewhere'));
    expect(make().service.info().canSelfUpdate).toBe(false);
    installed();
    expect(make().service.info().canSelfUpdate).toBe(true);
    expect(make({ dataDir: undefined }).service.info().canSelfUpdate).toBe(false);
    // update.sh runs the installer: without it, an update would only fail.
    rmSync(join(t.dir, 'deploy', 'install.sh'));
    expect(make().service.info().canSelfUpdate).toBe(false);
  });

  it("refuses when it can't update itself or is up to date", async () => {
    const { service } = make({ fetch: (async () => json(release('v0.3.0'))) as typeof fetch });
    await expect(service.apply()).rejects.toBeInstanceOf(UpdateError);
    installed();
    const latest = make({ fetch: (async () => json(release('v0.2.0'))) as typeof fetch });
    await expect(latest.service.apply()).rejects.toThrow(/latest version/);
    expect(existsSync(join(t.dir, REQUEST_FILE))).toBe(false);
  });

  it('asks the updater by writing the request file', async () => {
    installed();
    const { service } = make({ fetch: (async () => json(release('v0.3.0'))) as typeof fetch, now: () => 5000 });
    const events: UpdateInfo[] = [];
    service.on('update', (u: UpdateInfo) => events.push(u));
    const info = await service.apply();
    expect(info.state).toBe('updating');
    expect(events.at(-1)?.state).toBe('updating');
    expect(JSON.parse(readFileSync(join(t.dir, REQUEST_FILE), 'utf8'))).toEqual({ version: '0.3.0', requestedAt: 5000 });
    // Asking twice doesn't start a second update.
    expect((await service.apply()).state).toBe('updating');
  });

  it("reports the updater's result while it waits", async () => {
    vi.useFakeTimers();
    installed();
    const { service } = make({ fetch: (async () => json(release('v0.3.0'))) as typeof fetch, pollMs: 1000 });
    const events: UpdateInfo[] = [];
    service.on('update', (u: UpdateInfo) => events.push(u));
    await service.apply();
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.info().state).toBe('updating');

    writeFileSync(
      join(t.dir, STATUS_FILE),
      JSON.stringify({ ok: false, version: '0.3.0', from: '0.2.0', at: Date.now(), error: "Couldn't download the release" }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.info()).toMatchObject({ state: 'failed', error: "Couldn't download the release" });
    expect(events.at(-1)?.state).toBe('failed');
    expect(existsSync(join(t.dir, REQUEST_FILE))).toBe(false);

    // Trying again clears the failure.
    await service.apply();
    expect(service.info()).toMatchObject({ state: 'updating', error: null });
  });

  it('after the restart, the new version picks up the result', async () => {
    installed();
    let now = 10_000;
    const old = make({ fetch: (async () => json(release('v0.3.0'))) as typeof fetch, now: () => now });
    await old.service.apply();
    old.service.stop();

    // update.sh restarted the hub before writing its result: still updating.
    now = 20_000;
    const restarted = make({ version: '0.3.0', now: () => now, pollMs: 1000 });
    expect(restarted.service.info().state).toBe('updating');

    writeFileSync(join(t.dir, STATUS_FILE), JSON.stringify({ ok: true, version: '0.3.0', from: '0.2.0', at: 25_000, error: null }));
    vi.useFakeTimers();
    restarted.service.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(restarted.service.info()).toMatchObject({ state: 'idle', error: null, current: '0.3.0' });
    restarted.service.stop();

    // Seen once: another restart doesn't report it again.
    const again = make({ version: '0.3.0', now: () => now });
    expect(again.service.info()).toMatchObject({ state: 'idle', error: null });
  });

  it('shows a failed update found at startup, once', () => {
    writeFileSync(
      join(t.dir, STATUS_FILE),
      JSON.stringify({ ok: false, version: '0.3.0', from: '0.2.0', at: 1234, error: "The new version didn't start, so 0.2.0 is back" }),
    );
    expect(make().service.info()).toMatchObject({ state: 'failed', error: "The new version didn't start, so 0.2.0 is back" });
    expect(make().service.info()).toMatchObject({ state: 'idle', error: null });
  });

  it('gives up when nothing picks up the request', async () => {
    vi.useFakeTimers();
    installed();
    const { service } = make({ fetch: (async () => json(release('v0.3.0'))) as typeof fetch, pollMs: 1000 });
    await service.apply();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(service.info().state).toBe('failed');
    expect(service.info().error).toMatch(/Nothing picked up/);
    expect(existsSync(join(t.dir, REQUEST_FILE))).toBe(false);
  });
});

describe('UpdateService development builds', () => {
  const newer = (async () => json(release('v0.3.0'))) as typeof fetch;

  it("says it runs a development build, and doesn't compare releases with it", async () => {
    devDeployed();
    writeFileSync(join(t.dir, '.installer'), 'version=0.2.0\n');
    const { service } = make({ fetch: newer, build: BUILD });
    const info = await service.check();
    expect(info).toMatchObject({
      latest: '0.3.0',
      available: false,
      canSelfUpdate: false,
      devBuild: BUILD,
      canSwitchToRelease: true,
    });
    await expect(service.apply()).rejects.toThrow(/development build/);
    expect(existsSync(join(t.dir, REQUEST_FILE))).toBe(false);
  });

  it('is a release without the marker, and the dev server is always a development build', () => {
    installed();
    expect(make({ build: BUILD }).service.info()).toMatchObject({ devBuild: null, canSwitchToRelease: false, canSelfUpdate: true });
    expect(make({ fromSource: true }).service.info()).toMatchObject({
      devBuild: { commit: null, changes: false, builtAt: null },
      canSwitchToRelease: false,
      canSelfUpdate: false,
    });
  });

  it('can switch only when the updater and its installer are there', () => {
    writeFileSync(join(t.dir, '.dev-build'), '');
    expect(make().service.info().canSwitchToRelease).toBe(false);
    devDeployed();
    expect(make().service.info().canSwitchToRelease).toBe(true);
    rmSync(join(t.dir, 'deploy', 'install.sh'));
    expect(make().service.info().canSwitchToRelease).toBe(false);
  });

  it('switches to the latest release even when it has the same version number', async () => {
    devDeployed();
    const fetch = vi.fn(async () => json(release('v0.2.0')));
    const { service } = make({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => 7000 });
    const events: UpdateInfo[] = [];
    service.on('update', (u: UpdateInfo) => events.push(u));

    const info = await service.switchToRelease();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(info).toMatchObject({ state: 'updating', latest: '0.2.0' });
    expect(events.at(-1)?.state).toBe('updating');
    expect(JSON.parse(readFileSync(join(t.dir, REQUEST_FILE), 'utf8'))).toEqual({ version: '0.2.0', requestedAt: 7000 });
    expect((await service.switchToRelease()).state).toBe('updating');
  });

  it("refuses on a release, without the updater, or when there's no release", async () => {
    installed();
    await expect(make({ fetch: newer }).service.switchToRelease()).rejects.toThrow(/already on a release/);
    await expect(make({ fetch: newer, fromSource: true }).service.switchToRelease()).rejects.toThrow(/installer/);

    rmSync(join(t.dir, '.installer'));
    writeFileSync(join(t.dir, '.dev-build'), '');
    rmSync(join(t.dir, 'deploy', 'install.sh'));
    await expect(make({ fetch: newer }).service.switchToRelease()).rejects.toThrow(/installer/);

    devDeployed();
    const none = make({ fetch: (async () => json({ message: 'Not Found' }, 404)) as typeof fetch });
    await expect(none.service.switchToRelease()).rejects.toThrow(/No release/);
    const offline = make({
      fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
      // Past the half-minute in which "Check now" reuses the last answer.
      now: () => Date.now() + 60_000,
    });
    await expect(offline.service.switchToRelease()).rejects.toThrow(/Couldn't check for releases/);
    expect(existsSync(join(t.dir, REQUEST_FILE))).toBe(false);
  });
});

describe('update routes', () => {
  async function app(owner: boolean, dev = false) {
    if (dev) devDeployed();
    else installed();
    const { service } = make({ fetch: (async () => json(release('v0.3.0'))) as typeof fetch });
    const fastify = Fastify();
    const ctx = {
      app: fastify,
      s: { updates: service },
      owner: {
        preHandler: async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
          if (!owner) return reply.code(403).send({ error: 'Only the owner can do that.' });
        },
      },
    } as unknown as RouteContext;
    updateRoutes(ctx);
    await fastify.ready();
    return fastify;
  }

  it('lets anyone look but only the owner check and update', async () => {
    const viewer = await app(false);
    expect((await viewer.inject({ method: 'GET', url: '/api/update' })).json()).toMatchObject({ current: '0.2.0', state: 'idle' });
    expect((await viewer.inject({ method: 'POST', url: '/api/update/check' })).statusCode).toBe(403);
    expect((await viewer.inject({ method: 'POST', url: '/api/update/apply' })).statusCode).toBe(403);
    expect((await viewer.inject({ method: 'POST', url: '/api/update/switch' })).statusCode).toBe(403);
    await viewer.close();

    const owner = await app(true);
    expect((await owner.inject({ method: 'POST', url: '/api/update/check' })).json()).toMatchObject({ latest: '0.3.0', available: true });
    expect((await owner.inject({ method: 'POST', url: '/api/update/apply' })).json()).toMatchObject({ state: 'updating' });
    await owner.close();
  });

  it('lets the owner switch a development build to the latest release', async () => {
    const owner = await app(true, true);
    expect((await owner.inject({ method: 'GET', url: '/api/update' })).json()).toMatchObject({ canSwitchToRelease: true });
    expect((await owner.inject({ method: 'POST', url: '/api/update/switch' })).json()).toMatchObject({ state: 'updating' });
    await owner.close();
  });
});
