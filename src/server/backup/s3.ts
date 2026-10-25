import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import type { S3Settings } from '@rapthooker/shared';

/**
 * A small S3 client (PUT, DELETE, ListObjectsV2) signed with AWS Signature Version 4, so backups can go to AWS S3,
 * Cloudflare R2, Backblaze B2, MinIO, Wasabi and other S3-compatible storage without the AWS SDK.
 * Signing follows https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html. Uploads send the
 * real SHA-256 of the file in x-amz-content-sha256 (the file is read twice: once to hash it, once to send it).
 */

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ (and / in paths when asked). */
export function uriEncode(s: string, keepSlash = false): string {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, '/') : out;
}

/** 20130524T000000Z */
export const amzDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

export interface SignInput {
  method: string;
  /** The request path, already URI-encoded (it is used as it is in the canonical request). */
  path: string;
  query?: Record<string, string>;
  /** Headers to sign; must include host. x-amz-date and x-amz-content-sha256 are added. */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  date: Date;
}

export interface Signed {
  /** The headers to send: the signed ones plus authorization. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export function canonicalQuery(query: Record<string, string> = {}): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function signV4(input: SignInput): Signed {
  const service = input.service ?? 's3';
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  headers['x-amz-content-sha256'] = input.payloadHash;
  headers['x-amz-date'] = stamp;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery(input.query),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return {
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** "rapthooker" → "rapthooker/", "/a/b/" → "a/b/", "" → "". */
export function normalizePrefix(prefix: string): string {
  const p = prefix.trim().replace(/^\/+/, '');
  return p && !p.endsWith('/') ? `${p}/` : p;
}

const FRIENDLY: Record<string, string> = {
  SignatureDoesNotMatch: "The secret access key doesn't match the access key ID (or the region is wrong)",
  InvalidAccessKeyId: "The access key ID isn't recognised by this storage service",
  AccessDenied: "This key isn't allowed to do that: it needs permission to upload, list and delete in the bucket",
  NoSuchBucket: "There's no bucket with that name at this address",
  AuthorizationHeaderMalformed: "The region doesn't match the bucket's region",
  PermanentRedirect: 'The bucket is in another region: use that region and its endpoint',
  IllegalLocationConstraintException: "The region doesn't match the bucket's region",
  RequestTimeTooSkewed: "The hub's clock is too far off for the storage service to accept the request",
  InvalidBucketName: "That isn't a valid bucket name",
  AllAccessDisabled: 'All access to this bucket has been disabled',
  AccountProblem: "There's a problem with the storage account",
  EntityTooLarge: 'The file is bigger than the storage service allows',
  QuotaExceeded: 'The storage account is full',
  NotImplemented: "This storage service doesn't support something RaptHooker needs",
};

export class S3Error extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number | null,
  ) {
    super(message);
  }
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const xmlValue = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? unescapeXml(m[1]!) : null;
};

/** A readable error from an S3 error response, e.g. "This key isn't allowed to do that... (AccessDenied)". */
export function s3ErrorFrom(status: number, body: string): S3Error {
  const code = xmlValue(body, 'Code');
  const message = xmlValue(body, 'Message');
  const friendly = code ? FRIENDLY[code] : undefined;
  const fallback =
    status === 403
      ? 'Access denied (check the keys, the region and the bucket permissions)'
      : status === 404
        ? 'Not found (check the bucket name and the endpoint)'
        : status === 301 || status === 307
          ? 'The bucket is somewhere else: check the region and the endpoint'
          : `The storage service answered ${status}`;
  const text = friendly ?? message ?? fallback;
  return new S3Error(code ? `${text} (${code})` : text, code, status);
}

function networkError(err: NodeJS.ErrnoException, host: string): S3Error {
  const why: Record<string, string> = {
    ENOTFOUND: `Couldn't find ${host}: check the endpoint (and the hub's internet connection)`,
    EAI_AGAIN: `Couldn't look up ${host}: is the hub online?`,
    ECONNREFUSED: `${host} refused the connection: check the endpoint and port`,
    ECONNRESET: `${host} dropped the connection`,
    ETIMEDOUT: `${host} didn't answer in time`,
    EHOSTUNREACH: `Can't reach ${host}`,
    ENETUNREACH: "The hub isn't online",
    CERT_HAS_EXPIRED: `${host}'s HTTPS certificate has expired`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `${host} uses a self-signed HTTPS certificate`,
    SELF_SIGNED_CERT_IN_CHAIN: `${host} uses a self-signed HTTPS certificate`,
    ERR_TLS_CERT_ALTNAME_INVALID: `${host}'s HTTPS certificate is for a different name (try path-style addressing)`,
  };
  return new S3Error((err.code && why[err.code]) || `Couldn't reach ${host}: ${err.message}`, err.code ?? null, null);
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: number;
}

interface SendOptions {
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Buffer | (() => Readable);
  contentLength?: number;
  payloadHash?: string;
}

const MAX_RESPONSE = 8 * 1024 * 1024;

export class S3Client {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly s: S3Settings,
    opts: { timeoutMs?: number; now?: () => Date } = {},
  ) {
    const missing = [
      !s.bucket.trim() && 'bucket',
      !s.accessKeyId.trim() && 'access key ID',
      !s.secretAccessKey && 'secret access key',
      !s.endpoint.trim() && !s.region.trim() && 'endpoint or region',
    ].filter(Boolean);
    if (missing.length) throw new S3Error(`Fill in the ${missing.join(', ')}`, null, null);
    const raw = s.endpoint.trim() || `https://s3.${s.region.trim()}.amazonaws.com`;
    try {
      this.endpoint = new URL(raw);
    } catch {
      throw new S3Error(`"${raw}" isn't a web address`, null, null);
    }
    if (this.endpoint.protocol !== 'https:' && this.endpoint.protocol !== 'http:') {
      throw new S3Error('The endpoint must start with https:// (or http:// on your own network)', null, null);
    }
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.now = opts.now ?? (() => new Date());
  }

  get region(): string {
    return this.s.region.trim() || 'us-east-1';
  }

  /** Where a request for an object (or the bucket, when key is empty) goes: Host header, host to connect to and encoded path. */
  target(key = ''): { host: string; hostname: string; path: string } {
    const base = this.endpoint.pathname.replace(/\/+$/, '');
    const bucket = this.s.bucket.trim();
    const encodedKey = key ? `/${uriEncode(key, true)}` : '';
    const hostname = this.endpoint.hostname.replace(/^\[|\]$/g, '');
    if (this.s.pathStyle) return { host: this.endpoint.host, hostname, path: `${base}/${uriEncode(bucket)}${encodedKey}` };
    return { host: `${bucket}.${this.endpoint.host}`, hostname: `${bucket}.${hostname}`, path: `${base}${encodedKey}` || '/' };
  }

  private send(method: string, o: SendOptions = {}): Promise<string> {
    const { host, hostname, path } = this.target(o.key);
    const body = o.body;
    const payloadHash = o.payloadHash ?? (Buffer.isBuffer(body) ? sha256Hex(body) : EMPTY_SHA256);
    const signed = signV4({
      method,
      path,
      query: o.query,
      headers: { host, ...o.headers },
      payloadHash,
      accessKeyId: this.s.accessKeyId.trim(),
      secretAccessKey: this.s.secretAccessKey,
      region: this.region,
      date: this.now(),
    });
    const length = Buffer.isBuffer(body) ? body.length : (o.contentLength ?? 0);
    const qs = canonicalQuery(o.query);
    const options: RequestOptions = {
      method,
      hostname,
      port: this.endpoint.port || undefined,
      path: qs ? `${path}?${qs}` : path,
      headers: { ...signed.headers, ...(body ? { 'content-length': String(length) } : {}) },
    };
    const send = this.endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err instanceof S3Error ? err : networkError(err as NodeJS.ErrnoException, host));
      };
      const req = send(options, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= MAX_RESPONSE) chunks.push(c);
        });
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(text);
          else reject(s3ErrorFrom(status, text));
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', fail);
      if (Buffer.isBuffer(body)) req.end(body);
      else if (body) {
        const stream = body();
        stream.on('error', (err) => {
          fail(err);
          req.destroy();
        });
        stream.pipe(req);
      } else req.end();
    });
  }

  async putObject(key: string, body: Buffer | string, contentType = 'text/plain; charset=utf-8'): Promise<void> {
    await this.send('PUT', { key, body: Buffer.from(body), headers: { 'content-type': contentType } });
  }

  async putFile(key: string, file: string, contentType = 'application/octet-stream'): Promise<void> {
    const { size } = await stat(file);
    const payloadHash = await sha256File(file);
    await this.send('PUT', {
      key,
      body: () => createReadStream(file),
      contentLength: size,
      payloadHash,
      headers: { 'content-type': contentType },
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.send('DELETE', { key });
  }

  /** Objects under a prefix (ListObjectsV2; every page up to 20 000 objects, or just the first `maxKeys`). */
  async list(prefix: string, maxKeys?: number): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (maxKeys) query['max-keys'] = String(maxKeys);
      if (token) query['continuation-token'] = token;
      const body = await this.send('GET', { query });
      for (const m of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const xml = m[1]!;
        const key = xmlValue(xml, 'Key');
        if (key === null) continue;
        out.push({ key, size: Number(xmlValue(xml, 'Size') ?? 0), lastModified: Date.parse(xmlValue(xml, 'LastModified') ?? '') || 0 });
      }
      token = xmlValue(body, 'IsTruncated') === 'true' ? xmlValue(body, 'NextContinuationToken') : null;
      if (!token || maxKeys) break;
    }
    return out;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Deletes all but the newest `keep` daily backups (prefix + rapthooker-YYYY-MM-DD.db). Returns how many went. */
export async function pruneS3Backups(client: S3Client, prefix: string, keep: number): Promise<number> {
  const re = new RegExp(`^${escapeRe(prefix)}rapthooker-\\d{4}-\\d{2}-\\d{2}\\.db$`);
  const old = (await client.list(`${prefix}rapthooker-`))
    .map((o) => o.key)
    .filter((k) => re.test(k))
    .sort()
    .reverse()
    .slice(keep);
  for (const key of old) await client.deleteObject(key);
  return old.length;
}

/** Deletes the weekly CSV folders (prefix + csv/YYYY-MM-DD/) beyond the newest `keep`. Returns how many files went. */
export async function pruneS3Csv(client: S3Client, prefix: string, keep: number): Promise<number> {
  const re = new RegExp(`^${escapeRe(prefix)}csv/(\\d{4}-\\d{2}-\\d{2})/`);
  const objects = await client.list(`${prefix}csv/`);
  const weeks = [...new Set(objects.map((o) => re.exec(o.key)?.[1]).filter((w): w is string => !!w))].sort().reverse();
  const drop = new Set(weeks.slice(keep));
  const old = objects.filter((o) => drop.has(re.exec(o.key)?.[1] ?? ''));
  for (const o of old) await client.deleteObject(o.key);
  return old.length;
}

/**
 * Checks S3 settings by uploading a tiny test file, listing the folder (needed to tidy up old backups) and deleting
 * the test file. Throws a readable S3Error when the upload fails; `warning` says when only the tidying up won't work.
 */
export async function testS3(s: S3Settings): Promise<{ key: string; warning: string | null }> {
  const client = new S3Client(s, { timeoutMs: 20_000 });
  const prefix = normalizePrefix(s.prefix);
  const key = `${prefix}rapthooker-connection-test.txt`;
  await client.putObject(key, `RaptHooker connection test, ${new Date().toISOString()}. Safe to delete.\n`);
  const problems: string[] = [];
  try {
    await client.list(prefix, 1);
  } catch (err) {
    problems.push(`listing files failed: ${(err as Error).message}`);
  }
  try {
    await client.deleteObject(key);
  } catch (err) {
    problems.push(`deleting the test file failed: ${(err as Error).message}`);
  }
  const warning = problems.length
    ? `Uploading works, but ${problems.join('; ')}. Old backups won't be tidied up: set a lifecycle rule on the bucket instead.`
    : null;
  return { key, warning };
}
