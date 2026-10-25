import { Writable } from 'node:stream';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import pino from 'pino';
import { z } from 'zod';
import { BROWSER_PUSH, type AlertRuleInput, type ChannelInput, type Pill, type Reading } from '@rapthooker/shared';
import { ChannelError, ChannelService, type ChannelDeps, type MailTransport, type Notification } from '../channels.js';
import { AlertService } from '../alerts.js';
import { MASKED, Settings } from '../settings.js';
import { FLAG_IMPLAUSIBLE } from '../db.js';
import { channelRoutes } from '../routes/channels.js';
import { alertRoutes } from '../routes/alerts.js';
import type { RouteContext } from '../routes/context.js';
import type { Services } from '../server.js';
import { silent, tempStore } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const NOW = Date.UTC(2026, 9, 1, 12);

const NTFY: ChannelInput = {
  name: 'Phone',
  kind: 'ntfy',
  enabled: true,
  config: { server: 'https://ntfy.example.com/', topic: 'rapthooker-secret-topic', token: 'tk_supersecrettoken' },
};
const PUSHOVER: ChannelInput = {
  name: 'Pushover',
  kind: 'pushover',
  enabled: true,
  config: { token: 'appTOKEN1234567890abcdefghijkl', user: 'userKEY1234567890abcdefghijklm', device: 'phone' },
};
const TELEGRAM: ChannelInput = {
  name: 'Telegram',
  kind: 'telegram',
  enabled: true,
  config: { botToken: '123456789:AAEsecretBotToken_abc-def', chatId: '-1001234567' },
};
const DISCORD: ChannelInput = {
  name: 'Discord',
  kind: 'discord',
  enabled: true,
  config: { url: 'https://discord.com/api/webhooks/123456789012345678/secretWebhookToken_abc-DEF' },
};
const EMAIL: ChannelInput = {
  name: 'Email',
  kind: 'email',
  enabled: true,
  config: {
    host: 'smtp.example.com',
    port: '465',
    security: 'tls',
    username: 'brewer@example.com',
    password: 'mail-secret-pass',
    from: 'RaptHooker <brewer@example.com>',
    to: 'brewer@example.com, partner@example.com',
  },
};
const SECRETS = [
  'rapthooker-secret-topic',
  'tk_supersecrettoken',
  'appTOKEN1234567890abcdefghijkl',
  'userKEY1234567890abcdefghijklm',
  'AAEsecretBotToken_abc-def',
  'secretWebhookToken_abc-DEF',
  'mail-secret-pass',
];

const FIRED: Notification = { title: 'Too warm', message: 'Kveik is at 23.0 °C, above 22.0 °C', priority: 'high', kind: 'fired' };
const RESOLVED: Notification = { title: 'Pill goes quiet', message: 'Kveik is back', priority: 'normal', kind: 'resolved' };

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}
type Respond = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(opts: { respond?: Respond } & Omit<ChannelDeps, 'fetch'> = {}) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const calls: Call[] = [];
  const respond: Respond = opts.respond ?? (() => new Response('{"status":1}', { status: 200 }));
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body ?? '');
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body });
    return respond(String(input), init);
  });
  const lines: string[] = [];
  const log = pino(
    { level: 'debug' },
    new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  );
  const channels = new ChannelService(t.store, log, {
    fetch: fetchMock as unknown as typeof fetch,
    now: () => NOW,
    createTransport: opts.createTransport,
    timeoutMs: opts.timeoutMs,
  });
  channels.load();
  return { ...t, channels, calls, fetchMock, logText: () => lines.join('') };
}

const expectNoSecrets = (text: string) => {
  for (const s of SECRETS) expect(text).not.toContain(s);
};

describe('notification channels', () => {
  it('posts to ntfy with title, priority, tags and the access token', async () => {
    const { channels, calls } = setup();
    const ch = channels.create(NTFY);
    await channels.send([ch.id], FIRED);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://ntfy.example.com/rapthooker-secret-topic');
    expect(c.method).toBe('POST');
    expect(c.headers.get('x-title')).toBe('Too warm');
    expect(c.headers.get('x-priority')).toBe('high');
    expect(c.headers.get('x-tags')).toBe('warning');
    expect(c.headers.get('authorization')).toBe('Bearer tk_supersecrettoken');
    expect(c.body).toBe(FIRED.message);

    await channels.send([ch.id], { ...RESOLVED, title: 'Kveik 🍺 is back' });
    const r = calls[1]!;
    expect(r.headers.get('x-priority')).toBe('default');
    expect(r.headers.get('x-tags')).toBe('white_check_mark');
    const encoded = /^=\?UTF-8\?B\?(.+)\?=$/.exec(r.headers.get('x-title')!)?.[1];
    expect(Buffer.from(encoded!, 'base64').toString('utf8')).toBe('Kveik 🍺 is back');
    expect(channels.get(ch.id)).toMatchObject({ lastOk: true, lastError: null, lastAt: NOW });
  });

  it('really sends over HTTP, with non-ASCII titles encoded (to a local stand-in for an ntfy server)', async () => {
    const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"abc"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    const t = tempStore();
    cleanups.push(t.cleanup);
    const channels = new ChannelService(t.store, silent);
    const port = (server.address() as AddressInfo).port;
    const ch = channels.create({
      ...NTFY,
      config: { server: `http://127.0.0.1:${port}`, topic: 'brew', username: 'brewer', password: 'pässword' },
    });
    await channels.send([ch.id], { ...FIRED, title: 'Warmer than 22 °C 🍺' });
    expect(channels.get(ch.id)).toMatchObject({ lastOk: true, lastError: null });
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.url).toBe('/brew');
    expect(r.body).toBe(FIRED.message);
    expect(r.headers['x-priority']).toBe('high');
    expect(r.headers.authorization).toBe(`Basic ${Buffer.from('brewer:pässword').toString('base64')}`);
    const encoded = /^=\?UTF-8\?B\?(.+)\?=$/.exec(String(r.headers['x-title']))?.[1];
    expect(Buffer.from(encoded!, 'base64').toString('utf8')).toBe('Warmer than 22 °C 🍺');
  });

  it('uses a username and password for ntfy when there is no token', async () => {
    const { channels, calls } = setup();
    const ch = channels.create({ ...NTFY, config: { topic: 'brew-alerts', username: 'brewer', password: 'pa:ss' } });
    expect(ch.config.server).toBe('https://ntfy.sh');
    await channels.send('all', FIRED);
    expect(calls[0]!.url).toBe('https://ntfy.sh/brew-alerts');
    expect(calls[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from('brewer:pa:ss').toString('base64')}`);
  });

  it('posts a Pushover form with priority 1 for alerts and 0 for all-clears', async () => {
    const { channels, calls } = setup();
    const ch = channels.create(PUSHOVER);
    await channels.send([ch.id], FIRED);
    await channels.send([ch.id], RESOLVED);
    expect(calls[0]!.url).toBe('https://api.pushover.net/1/messages.json');
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      token: PUSHOVER.config.token,
      user: PUSHOVER.config.user,
      title: 'Too warm',
      message: FIRED.message,
      priority: '1',
      device: 'phone',
    });
    expect(new URLSearchParams(calls[1]!.body).get('priority')).toBe('0');
  });

  it('sends Telegram messages as escaped HTML', async () => {
    const { channels, calls } = setup({ respond: () => new Response('{"ok":true}') });
    const ch = channels.create(TELEGRAM);
    await channels.send([ch.id], { ...FIRED, title: 'Hot & <bubbly>', message: 'Kveik <3 is at 23.0 °C' });
    expect(calls[0]!.url).toBe('https://api.telegram.org/bot123456789:AAEsecretBotToken_abc-def/sendMessage');
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      chat_id: '-1001234567',
      text: '<b>Hot &amp; &lt;bubbly&gt;</b>\nKveik &lt;3 is at 23.0 °C',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('posts a Discord embed as RaptHooker', async () => {
    const { channels, calls } = setup({ respond: () => new Response(null, { status: 204 }) });
    const ch = channels.create(DISCORD);
    await channels.send([ch.id], FIRED);
    expect(calls[0]!.url).toBe(DISCORD.config.url);
    expect(JSON.parse(calls[0]!.body)).toEqual({
      username: 'RaptHooker',
      embeds: [{ title: 'Too warm', description: FIRED.message, color: 0xfbbf24, timestamp: new Date(NOW).toISOString() }],
      allowed_mentions: { parse: [] },
    });
    expect(channels.get(ch.id)!.lastOk).toBe(true);
  });

  it('sends email through SMTP with the chosen security', async () => {
    const made: SMTPTransport.Options[] = [];
    const mails: Record<string, unknown>[] = [];
    let closed = 0;
    const createTransport = (options: SMTPTransport.Options): MailTransport => {
      made.push(options);
      const json = nodemailer.createTransport({ jsonTransport: true });
      return {
        sendMail: async (mail) => {
          const info = await json.sendMail(mail);
          mails.push(JSON.parse(info.message) as Record<string, unknown>);
          return info;
        },
        close: () => {
          closed++;
          json.close();
        },
      };
    };
    const { channels } = setup({ createTransport });
    const ch = channels.create(EMAIL);
    await channels.send([ch.id], FIRED);
    expect(made[0]).toMatchObject({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
      auth: { user: 'brewer@example.com', pass: 'mail-secret-pass' },
      connectionTimeout: 10_000,
    });
    expect(mails[0]).toMatchObject({
      subject: 'Too warm',
      from: { address: 'brewer@example.com', name: 'RaptHooker' },
      to: [{ address: 'brewer@example.com' }, { address: 'partner@example.com' }],
    });
    expect(String(mails[0]!.text)).toContain(FIRED.message);
    expect(mails[0]!.priority).toBe('high');
    expect(closed).toBe(1);

    channels.update(ch.id, { ...EMAIL, config: { ...EMAIL.config, port: '587', security: 'starttls', username: '', password: '' } });
    await channels.send([ch.id], RESOLVED);
    expect(made[1]).toMatchObject({ port: 587, secure: false, requireTLS: true, auth: undefined });
    expect(channels.get(ch.id)!.lastOk).toBe(true);
  });

  it('reports failures readably, without keys or tokens, and carries on with the other channels', async () => {
    const { channels, logText } = setup({
      respond: (url) => {
        if (url.includes('telegram')) return new Response('{"ok":false,"error_code":401,"description":"Unauthorized"}', { status: 401 });
        if (url.includes('ntfy'))
          return new Response('{"code":40301,"http":403,"error":"forbidden: rapthooker-secret-topic with tk_supersecrettoken"}', {
            status: 403,
          });
        if (url.includes('pushover')) return new Response('{"user":"invalid","errors":["user identifier is invalid"],"status":0}');
        return new Response('<html><body>Not here</body></html>', { status: 404, statusText: 'Not Found' });
      },
      createTransport: () => ({
        sendMail: async () => {
          throw Object.assign(new Error('Invalid login: 535 Bad credentials (mail-secret-pass)'), { code: 'EAUTH' });
        },
        close: () => undefined,
      }),
    });
    const ids = [TELEGRAM, NTFY, PUSHOVER, DISCORD, EMAIL].map((input) => channels.create(input).id);
    await expect(channels.send(ids, FIRED)).resolves.toBeUndefined();
    const errors = ids.map((id) => channels.get(id)!.lastError);
    expect(errors).toEqual([
      'HTTP 401: Unauthorized',
      'HTTP 403: forbidden: •••• with ••••',
      'user identifier is invalid',
      'HTTP 404 Not Found',
      'Invalid login: 535 Bad credentials (••••)',
    ]);
    expect(ids.every((id) => channels.get(id)!.lastOk === false)).toBe(true);
    expectNoSecrets(JSON.stringify(errors));
    expect(logText()).toContain('notification failed');
    expectNoSecrets(logText());
  });

  it('explains network errors and timeouts', async () => {
    const failing = setup({
      respond: () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), { code: 'ENOTFOUND' }),
        });
      },
    });
    const tg = failing.channels.create(TELEGRAM);
    await failing.channels.send([tg.id], FIRED);
    expect(failing.channels.get(tg.id)!.lastError).toBe("Couldn't connect: getaddrinfo ENOTFOUND api.telegram.org");

    const refused = setup({
      respond: () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }) });
      },
    });
    const own = refused.channels.create({ ...NTFY, config: { server: 'http://localhost:2586', topic: 'brew' } });
    await refused.channels.send([own.id], FIRED);
    expect(refused.channels.get(own.id)!.lastError).toBe("Couldn't connect: the server refused the connection");

    const slow = setup({
      timeoutMs: 30,
      respond: (_url, init) =>
        new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error))),
    });
    const dc = slow.channels.create(DISCORD);
    await slow.channels.send([dc.id], FIRED);
    expect(slow.channels.get(dc.id)!.lastError).toBe('No answer within 1 s');
    expectNoSecrets(slow.logText());
  });

  it('sends to channels in parallel, skipping switched-off and unknown ones', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { channels, calls } = setup({
      respond: async (url) => {
        if (url.includes('ntfy')) await gate;
        else release();
        return new Response('{"status":1}');
      },
    });
    const a = channels.create(NTFY);
    const b = channels.create(PUSHOVER);
    const off = channels.create({ ...DISCORD, enabled: false });
    await channels.send([a.id, b.id, off.id, 'gone'], FIRED);
    expect(calls.map((c) => new URL(c.url).host).sort()).toEqual(['api.pushover.net', 'ntfy.example.com']);
    calls.length = 0;
    await channels.send('all', FIRED);
    expect(calls).toHaveLength(2);
    expect(channels.get(off.id)!.lastAt).toBeNull();
  });

  it('checks settings before switching a channel on', () => {
    const { channels } = setup();
    expect(() => channels.create({ ...NTFY, config: { topic: '' } })).toThrow(/Fill in Topic/);
    expect(() => channels.create({ ...NTFY, config: { topic: 'no spaces please' } })).toThrow(ChannelError);
    expect(() => channels.create({ ...DISCORD, config: { url: 'https://example.com/hook' } })).toThrow(/discord\.com\/api\/webhooks/);
    expect(() => channels.create({ ...TELEGRAM, config: { botToken: 'nope', chatId: '1' } })).toThrow(/Bot token/);
    expect(() => channels.create({ ...EMAIL, config: { ...EMAIL.config, to: 'brewer' } })).toThrow(/To should be/);
    const draft = channels.create({ ...NTFY, enabled: false, config: { topic: '' } });
    expect(draft).toMatchObject({ enabled: false, config: { server: 'https://ntfy.sh', topic: '' } });
    expect(() => channels.update(draft.id, { ...draft, enabled: true })).toThrow(/Fill in Topic/);
  });

  it('hides secrets from viewers and keeps saved secrets when masked values come back', async () => {
    const { channels, store, calls } = setup({ respond: () => new Response('{"error":"nope"}', { status: 403 }) });
    const ch = channels.create(EMAIL);
    const viewer = channels.list(false)[0]!;
    expect(viewer.masked).toBe(true);
    expect(viewer.config).toMatchObject({
      host: 'smtp.example.com',
      port: '465',
      security: 'tls',
      password: MASKED,
      username: MASKED,
      to: MASKED,
    });
    expect(JSON.stringify(viewer)).not.toContain('example.com>');
    expect(JSON.stringify(viewer)).not.toContain('brewer@');
    expectNoSecrets(JSON.stringify(viewer));
    expect(channels.get(ch.id, false)!.config.from).toBe(MASKED);
    expect(channels.list(true)[0]!.config.password).toBe('mail-secret-pass');

    const renamed = channels.update(ch.id, { name: 'Mail', kind: 'email', enabled: true, config: viewer.config });
    expect(renamed.name).toBe('Mail');
    expect(renamed.config).toEqual(channels.list()[0]!.config);
    expect(renamed.config.password).toBe('mail-secret-pass');
    expect(renamed.config.to).toBe(EMAIL.config.to);
    expect(channels.update(ch.id, { ...EMAIL, config: { ...viewer.config, password: 'new-pass' } }).config.password).toBe('new-pass');

    expect(() => channels.create({ ...EMAIL, config: viewer.config })).toThrow(/Type the .* again/);
    expect(() => channels.update(ch.id, { ...TELEGRAM, config: { botToken: MASKED, chatId: '1' } })).toThrow(/Type the Bot token again/);

    const ntfy = channels.create(NTFY);
    await channels.send([ntfy.id], FIRED);
    expect(channels.get(ntfy.id, false)!.lastError).toBe('HTTP 403');
    expect(channels.get(ntfy.id)!.lastError).toBe('HTTP 403: nope');

    // Saved settings and results survive a restart.
    const again = new ChannelService(store, silent);
    again.load();
    expect(again.get(ntfy.id)).toMatchObject({ name: 'Phone', lastOk: false, lastError: 'HTTP 403: nope', lastAt: NOW });
    expect(calls).toHaveLength(1);
  });

  it('tests a channel with its saved secret and says why a test failed', async () => {
    let status = 200;
    const { channels, calls } = setup({
      respond: () => new Response('{"ok":false,"description":"Forbidden: bot was blocked"}', { status }),
    });
    const ch = channels.create(TELEGRAM);
    await channels.test({ ...TELEGRAM, config: { botToken: MASKED, chatId: '42' } }, ch.id, 'Garage');
    expect(calls[0]!.url).toContain(TELEGRAM.config.botToken);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      chat_id: '42',
      text: '<b>Garage</b>\nRaptHooker test: notifications from Garage work',
    });
    expect(channels.get(ch.id)!.lastAt).toBeNull();

    status = 403;
    const err = await channels.test(TELEGRAM, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as Error).message).toBe('HTTP 403: Forbidden: bot was blocked');
    await expect(channels.test({ ...TELEGRAM, config: { botToken: MASKED, chatId: '42' } }, null)).rejects.toThrow(
      /Type the Bot token again/,
    );
    await expect(channels.test({ ...NTFY, config: { topic: '' } }, null)).rejects.toThrow(/Fill in Topic/);
  });
});

const PILL = { id: 'p1', name: 'Kveik' } as Pill;

function reading(over: Partial<Reading> = {}): Reading {
  return {
    ts: NOW,
    gravity: 1.04,
    temperature: 20,
    velocity: null,
    battery: 90,
    rssi: -50,
    tilt: 40,
    x: 1,
    y: 2,
    z: 3,
    plausible: true,
    pillGravity: 1.04,
    pillVelocity: null,
    ...over,
  } as Reading;
}

const rule = (over: Partial<AlertRuleInput>): AlertRuleInput => ({
  name: 'Too warm',
  enabled: true,
  pillIds: 'all',
  kind: 'temp_above',
  threshold: 22,
  hours: 48,
  onlyDuringBrew: false,
  cooldownMin: 0,
  channelIds: 'all',
  ...over,
});

function alertSetup(respond?: Respond) {
  const base = setup({ respond: respond ?? (() => new Response('{"status":1}')) });
  let latest = reading();
  let heardAt = NOW;
  const pushed: string[] = [];
  const alerts = new AlertService(
    base.store,
    {
      pills: {
        get: (id) => (id === 'p1' ? PILL : null),
        activeIds: () => ['p1'],
        latest: () => latest,
        lastHeardAt: () => heardAt,
        offsets: () => ({ gravity: 0, temperature: 0 }),
      },
      brews: { activeFor: () => null },
      units: () => ({ temperature: 'C', gravity: 'sg' }),
      now: () => NOW,
    },
    { send: async (m) => void pushed.push(`${m.title}: ${m.body}`) },
    silent,
    base.channels,
  );
  alerts.load();
  return {
    ...base,
    alerts,
    pushed,
    setReading: (over: Partial<Reading>) => (latest = reading(over)),
    setHeardAt: (at: number) => (heardAt = at),
  };
}

const ntfyTitles = (calls: Call[]) => calls.filter((c) => c.url.includes('ntfy')).map((c) => c.headers.get('x-title'));
const discordTitles = (calls: Call[]) =>
  calls.filter((c) => c.url.includes('discord')).map((c) => (JSON.parse(c.body) as { embeds: { title: string }[] }).embeds[0]!.title);

describe('alerts through channels', () => {
  it("sends each alert to its rule's channels and browser push only when chosen", async () => {
    const t = alertSetup();
    const phone = t.channels.create(NTFY);
    const discord = t.channels.create(DISCORD);
    t.alerts.create(rule({ name: 'Everywhere', channelIds: 'all' }));
    t.alerts.create(rule({ name: 'Browser only', channelIds: [BROWSER_PUSH] }));
    t.alerts.create(rule({ name: 'Discord only', channelIds: [discord.id] }));
    t.alerts.create(rule({ name: 'Discord and browser', channelIds: [discord.id, BROWSER_PUSH] }));
    t.alerts.create(rule({ name: 'App only', channelIds: [] }));
    t.setReading({ temperature: 23 });
    t.alerts.evaluatePill('p1');
    await vi.waitFor(() => expect(t.calls).toHaveLength(4));
    expect(t.pushed.map((p) => p.split(':')[0]).sort()).toEqual(['Browser only', 'Discord and browser', 'Everywhere']);
    expect(ntfyTitles(t.calls)).toEqual(['Everywhere']);
    expect(discordTitles(t.calls).sort()).toEqual(['Discord and browser', 'Discord only', 'Everywhere']);
    expect(t.calls.find((c) => c.url.includes('ntfy'))!.headers.get('x-priority')).toBe('high');
    expect(t.alerts.events(10)).toHaveLength(5);
    await vi.waitFor(() => expect(t.channels.get(phone.id)!.lastOk).toBe(true));
  });

  it('sends "back again" for a quiet pill with normal priority', async () => {
    const t = alertSetup();
    const po = t.channels.create(PUSHOVER);
    t.alerts.create(rule({ name: 'Quiet', kind: 'offline', threshold: 60, channelIds: [po.id] }));
    t.setHeardAt(NOW - 2 * 3_600_000);
    t.alerts.evaluateAll();
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    t.setHeardAt(NOW);
    t.alerts.evaluateAll();
    await vi.waitFor(() => expect(t.calls).toHaveLength(2));
    const forms = t.calls.map((c) => new URLSearchParams(c.body));
    expect(forms.map((f) => f.get('priority'))).toEqual(['1', '0']);
    expect(forms[1]!.get('message')).toBe('Kveik is back');
    expect(t.pushed).toEqual([]);
  });

  it("ignores gravity from a pill that isn't floating, but not its temperature", async () => {
    const t = alertSetup();
    const phone = t.channels.create(NTFY);
    t.alerts.create(rule({ name: 'Target', kind: 'gravity_below', threshold: 1.012, channelIds: [phone.id] }));
    t.alerts.create(rule({ name: 'Warm', kind: 'temp_above', threshold: 22, channelIds: [phone.id] }));
    // Lying on the table: a gravity of 0.2057 and room temperature.
    t.setReading({ gravity: 0.2057, pillGravity: 0.2057, temperature: 24, plausible: false });
    t.alerts.evaluatePill('p1');
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(ntfyTitles(t.calls)).toEqual(['Warm']);
    t.setReading({ gravity: 1.01, temperature: 20 });
    t.alerts.evaluatePill('p1');
    await vi.waitFor(() => expect(ntfyTitles(t.calls)).toContain('Target'));
    expect(t.alerts.list().find((r) => r.name === 'Target')!.active).toEqual(['p1']);
  });

  it("doesn't call fermentation finished while the pill reads nonsense", () => {
    const t = alertSetup();
    for (let h = 50; h >= 1; h--) {
      t.store.addReading('p1', {
        ts: NOW - h * 3_600_000,
        sg: 1.01,
        temp: 20,
        velocity: 0,
        battery: 90,
        rssi: -50,
        x: 1,
        y: 2,
        z: 3,
        flags: 0,
      });
    }
    t.store.addReading('p1', {
      ts: NOW,
      sg: 0.2057,
      temp: 20,
      velocity: 0,
      battery: 90,
      rssi: -50,
      x: 1,
      y: 2,
      z: 3,
      flags: FLAG_IMPLAUSIBLE,
    });
    t.setReading({ gravity: 0.2057, pillGravity: 0.2057, plausible: false });
    t.alerts.create(rule({ name: 'Done', kind: 'gravity_stable', threshold: 1, hours: 48, channelIds: [] }));
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10)).toEqual([]);
    t.setReading({ gravity: 1.01 });
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => e.ruleName)).toEqual(['Done']);
    expect(t.alerts.events(10)[0]!.message).toContain('steady at 1.010');
  });

  it('loads rules saved before channels existed as going everywhere', async () => {
    const t = alertSetup();
    const { channelIds: _c, ...old } = rule({ name: 'Old rule' });
    t.store.saveAlertRule('old-rule', old, 1);
    const alerts = new AlertService(
      t.store,
      {
        pills: {
          get: () => PILL,
          activeIds: () => ['p1'],
          latest: () => reading({ temperature: 30 }),
          lastHeardAt: () => NOW,
          offsets: () => ({ gravity: 0, temperature: 0 }),
        },
        brews: { activeFor: () => null },
        units: () => ({ temperature: 'C', gravity: 'sg' }),
        now: () => NOW,
      },
      { send: async () => undefined },
      silent,
      t.channels,
    );
    alerts.load();
    expect(alerts.list()[0]!.channelIds).toBe('all');
    t.channels.create(DISCORD);
    alerts.evaluatePill('p1');
    await vi.waitFor(() => expect(discordTitles(t.calls)).toEqual(['Old rule']));
  });
});

async function routeSetup(respond?: Respond) {
  const t = alertSetup(respond);
  const app = Fastify();
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.message });
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  });
  const isOwner = (req: FastifyRequest) => req.headers['x-test-owner'] === 'yes';
  const ctx: RouteContext = {
    app,
    s: { channels: t.channels, alerts: t.alerts, settings: new Settings(t.store) } as unknown as Services,
    auth: undefined as never,
    sessionOf: () => ({ role: 'viewer' }) as never,
    isOwner,
    owner: {
      preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!isOwner(req)) return reply.code(403).send({ error: 'Only the owner can do that' });
        return undefined;
      },
    },
    broadcast: () => undefined,
  };
  channelRoutes(ctx);
  alertRoutes(ctx);
  await app.ready();
  cleanups.unshift(() => void app.close());
  return { ...t, app };
}

const owner = { 'x-test-owner': 'yes' };

describe('channel routes', () => {
  it('lets the owner manage channels, shows viewers masked ones, and tidies rules when one is deleted', async () => {
    const { app } = await routeSetup();
    expect((await app.inject({ method: 'POST', url: '/api/channels', payload: NTFY })).statusCode).toBe(403);
    const bad = await app.inject({ method: 'POST', url: '/api/channels', headers: owner, payload: { ...NTFY, config: {} } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('Fill in Topic');
    const created = await app.inject({ method: 'POST', url: '/api/channels', headers: owner, payload: NTFY });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;

    const asViewer = (await app.inject({ url: '/api/channels' })).json();
    expect(asViewer[0]).toMatchObject({ id, name: 'Phone', masked: true, config: { server: 'https://ntfy.example.com', topic: MASKED } });
    expectNoSecrets(JSON.stringify(asViewer));
    expect((await app.inject({ url: '/api/channels', headers: owner })).json()[0].config.topic).toBe('rapthooker-secret-topic');

    const masked = { ...NTFY, name: 'My phone', config: asViewer[0].config };
    const updated = await app.inject({ method: 'PUT', url: `/api/channels/${id}`, headers: owner, payload: masked });
    expect(updated.json()).toMatchObject({ name: 'My phone', config: { topic: 'rapthooker-secret-topic', token: 'tk_supersecrettoken' } });

    const ruleRes = await app.inject({
      method: 'POST',
      url: '/api/alerts/rules',
      headers: owner,
      payload: rule({ channelIds: [id, BROWSER_PUSH, 'no-such-channel'] }),
    });
    expect(ruleRes.json().channelIds).toEqual([id, BROWSER_PUSH]);
    const everywhere = await app.inject({ method: 'POST', url: '/api/alerts/rules', headers: owner, payload: rule({ name: 'All' }) });
    expect(everywhere.json().channelIds).toBe('all');

    expect((await app.inject({ method: 'DELETE', url: `/api/channels/${id}` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/channels/${id}`, headers: owner })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/channels/${id}`, headers: owner })).statusCode).toBe(404);
    const rules = (await app.inject({ url: '/api/alerts/rules' })).json() as { name: string; channelIds: string[] | 'all' }[];
    expect(rules.map((r) => r.channelIds)).toEqual([[BROWSER_PUSH], 'all']);
    expect((await app.inject({ url: '/api/channels', headers: owner })).json()).toEqual([]);
  });

  it('sends a test with the saved secret and reports failures without secrets', async () => {
    let status = 200;
    const { app, calls } = await routeSetup(() => new Response('{"description":"Unauthorized"}', { status }));
    const id = (await app.inject({ method: 'POST', url: '/api/channels', headers: owner, payload: TELEGRAM })).json().id as string;
    const payload = { channel: { ...TELEGRAM, config: { botToken: MASKED, chatId: '-1001234567' } }, id };
    expect((await app.inject({ method: 'POST', url: '/api/channels/test', payload })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/channels/test', headers: owner, payload });
    expect(ok.statusCode).toBe(200);
    expect(calls[0]!.url).toContain(TELEGRAM.config.botToken);
    expect(JSON.parse(calls[0]!.body).text).toContain('RaptHooker test: notifications from RaptHooker work');

    status = 401;
    const failed = await app.inject({ method: 'POST', url: '/api/channels/test', headers: owner, payload });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toEqual({ error: 'HTTP 401: Unauthorized' });
    expectNoSecrets(failed.body);
  });
});
