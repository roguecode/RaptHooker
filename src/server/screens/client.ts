import http from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** What a screen running RaptHooker firmware says about itself at /api/info. Fields only get added. */
export interface ScreenInfo {
  firmware: string;
  version: string;
  api: number;
  model: string;
  id: string;
  mac: string;
  hostname: string;
  name: string;
  hub: string;
  claimed: boolean;
  state: 'setup' | 'connecting' | 'online' | 'offline';
  safeMode: boolean;
  updating: boolean;
  features?: string[];
  /** HMAC of the challenge sent with /api/info, keyed with the screen's key (screenProof): firmware with "proof". */
  proof?: string;
  wifi: { ssid: string; ip?: string; rssi?: number; channel: number; hotspot: string; hotspotOn: boolean; reason: string };
  image: { url: string; interval: number; shown: boolean; ageMs: number; failures: number; error: string; bytes: number };
  setup: { trial: 'idle' | 'testing' | 'connected' | 'failed'; error: string; ip?: string; saved: boolean };
  system: { uptime: number; heap: number; sketchSize: number; freeSketch: number; sketchMd5: string; resetReason: string };
}

export interface ScreenSetupBody {
  ssid: string;
  password: string;
  token: string;
  hub: string;
  name: string;
  imageUrl: string;
  interval: number;
  brightness: number;
  channel: number;
}

export interface SetupStatus {
  trial: 'idle' | 'testing' | 'connected' | 'failed';
  error: string;
  ip?: string;
  saved: boolean;
  channel: number;
}

export interface ScreenSettingsBody {
  name?: string;
  hub?: string;
  imageUrl?: string;
  interval?: number;
  brightness?: number;
  token?: string;
  ssid?: string;
  password?: string;
}

export class ScreenRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** The whole request had gone when it failed: the screen may have acted on it. */
    readonly sent = false,
  ) {
    super(message);
  }
}

export interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  /** Send from this address (the hub's address on a screen's hotspot). */
  localAddress?: string;
}

/**
 * One HTTP request. Always sends Content-Length: the screens' web server can't read a chunked body. `host` may carry
 * a port (tests).
 */
export function request(host: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const [hostname, port] = host.includes(':') && !host.startsWith('[') ? host.split(':') : [host, '80'];
  const headers: Record<string, string | number> = { ...opts.headers };
  const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
  if (body) headers['Content-Length'] = body.length;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: hostname,
        port: Number(port),
        path,
        method: opts.method ?? 'GET',
        headers,
        timeout: opts.timeoutMs ?? 10_000,
        localAddress: opts.localAddress,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    let sent = false;
    req.on('finish', () => {
      sent = true;
    });
    req.on('timeout', () => req.destroy(new ScreenRequestError(`no answer from ${hostname} in time`, null, sent)));
    req.on('error', (err) => reject(err instanceof ScreenRequestError ? err : new ScreenRequestError(err.message, null, sent)));
    req.end(body);
  });
}

/** A multipart/form-data body with one file, as a browser would send it. */
export function multipart(field: string, filename: string, data: Buffer): { body: Buffer; type: string } {
  const boundary = `----rapthooker${randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  return { body: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` };
}

/** What a screen with key `token` answers to `challenge` (firmware/screen/src/web.cpp, handleInfo). */
export function screenProof(token: string, id: string, challenge: string): string {
  return createHmac('sha256', token).update(`rhscreen-proof:${id}:${challenge}`).digest('hex');
}

/** Whether `proof` is the screen's answer to `challenge`, compared in constant time. */
export function provesKey(proof: unknown, token: string, id: string, challenge: string): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/i.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof.toLowerCase(), 'hex'), Buffer.from(screenProof(token, id, challenge), 'hex'));
}

/** A screen running RaptHooker firmware (firmware/screen/src/web.cpp is the other side). */
export class ScreenClient {
  constructor(
    readonly host: string,
    private readonly token: string | null = null,
    private readonly localAddress?: string,
  ) {}

  private bearer(): Record<string, string> {
    return this.token ? { Authorization: 'Bearer ' + this.token } : {};
  }

  private async call<T>(method: string, path: string, json?: unknown, timeoutMs = 10_000, auth = true): Promise<T> {
    const headers: Record<string, string> = auth ? this.bearer() : {};
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const res = await request(this.host, path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
      timeoutMs,
      localAddress: this.localAddress,
    });
    let data: unknown = null;
    try {
      data = JSON.parse(res.body.toString('utf8'));
    } catch {}
    if (res.status < 200 || res.status >= 300) {
      const error = (data as { error?: string } | null)?.error;
      throw new ScreenRequestError(error ?? `HTTP ${res.status}`, res.status);
    }
    return data as T;
  }

  /** What the screen says about itself. Never sent with the key; with `challenge`, a screen that has one proves it. */
  info(timeoutMs = 8000, challenge?: string): Promise<ScreenInfo> {
    return this.call('GET', `/api/info${challenge ? `?challenge=${challenge}` : ''}`, undefined, timeoutMs, false);
  }

  /**
   * Has the screen here prove it's screen `id` with this client's key, without sending the key. `proven` is false
   * for firmware too old to prove it ("proof" isn't in its features). Throws if it's another screen, or a screen that
   * can prove it but doesn't have the key (reset, or set up by another hub): status 401.
   */
  async prove(id: string, timeoutMs = 8000): Promise<{ info: ScreenInfo; proven: boolean }> {
    const challenge = randomBytes(16).toString('hex');
    const info = await this.info(timeoutMs, challenge);
    if (info.id !== id) throw new ScreenRequestError('another screen is at that address', null);
    if (!info.features?.includes('proof')) return { info, proven: false };
    if (!this.token || !provesKey(info.proof, this.token, id, challenge)) {
      throw new ScreenRequestError("the screen there doesn't have the hub's key", 401);
    }
    return { info, proven: true };
  }

  setup(body: ScreenSetupBody): Promise<{ ok: boolean }> {
    return this.call('POST', '/api/setup', body);
  }

  setupStatus(): Promise<SetupStatus> {
    return this.call('GET', '/api/setup', undefined, 4000);
  }

  finish(): Promise<unknown> {
    return this.call('POST', '/api/setup/finish');
  }

  settings(body: ScreenSettingsBody): Promise<{ reboot: boolean }> {
    return this.call('POST', '/api/settings', body);
  }

  identify(): Promise<unknown> {
    return this.call('POST', '/api/identify');
  }

  refresh(): Promise<unknown> {
    return this.call('POST', '/api/refresh');
  }

  reboot(): Promise<unknown> {
    return this.call('POST', '/api/reboot');
  }

  reset(): Promise<unknown> {
    return this.call('POST', '/api/reset');
  }

  /** Asks the screen to show a pairing code. */
  showCode(): Promise<unknown> {
    return this.call('POST', '/api/adopt', {});
  }

  /** Takes the screen over with the code it shows. */
  adopt(body: { code: string; token: string; hub: string; name?: string; imageUrl?: string }): Promise<unknown> {
    return this.call('POST', '/api/adopt', body);
  }

  async log(): Promise<string> {
    const res = await request(this.host, '/api/log', {
      headers: this.bearer(),
      localAddress: this.localAddress,
    });
    if (res.status !== 200) throw new ScreenRequestError(`HTTP ${res.status}`, res.status);
    return res.body.toString('utf8');
  }

  /**
   * Sends new firmware. The screen checks it (size, MD5, that it's a complete image for its model unless `force`),
   * installs it and restarts. force 1 takes firmware that isn't RaptHooker's (the stock firmware, to go back to it).
   */
  async ota(data: Buffer, md5: string, force: 0 | 1 = 0): Promise<void> {
    const { body, type } = multipart('firmware', 'firmware.bin', data);
    const headers: Record<string, string> = { 'Content-Type': type };
    Object.assign(headers, this.bearer());
    const res = await request(this.host, `/api/ota?size=${data.length}&md5=${md5}${force ? `&force=${force}` : ''}`, {
      method: 'POST',
      headers,
      body,
      timeoutMs: 120_000,
      localAddress: this.localAddress,
    });
    if (res.status !== 200) {
      let error = `HTTP ${res.status}`;
      try {
        error = (JSON.parse(res.body.toString('utf8')) as { error?: string }).error ?? error;
      } catch {}
      throw new ScreenRequestError(error, res.status);
    }
  }
}
