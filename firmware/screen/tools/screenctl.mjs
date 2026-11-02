// Talks to a screen by hand, for development: the hub does all of this itself (src/server/screens). Usage:
//   node screenctl.mjs identify [host]                  stock firmware check (default 192.168.4.1)
//   node screenctl.mjs check <bin>                      validate an image for the stock OTA
//   node screenctl.mjs flash-stock <bin> [host]         upload to the stock /update_ota
//   node screenctl.mjs info [host]                      our firmware's /api/info
//   node screenctl.mjs setup <host> <json>              POST /api/setup then poll GET /api/setup
//   node screenctl.mjs finish <host> <token>
//   node screenctl.mjs settings <host> <token> <json>
//   node screenctl.mjs ota <host> <token> <bin> [force]
//   node screenctl.mjs call <host> <token> <method> <path> [json]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { basename } from 'node:path';

const STOCK_OTA_LIMIT = 0x80000;
const SAFE_LIMIT = 0x7c000;
const bind = process.env.BIND; // local address to send from, e.g. the Wi-Fi adapter's 192.168.4.x

function request(host, method, path, { headers = {}, body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    // The screen's web server can't read chunked bodies, so always say how long it is.
    if (body !== undefined) {
      body = Buffer.isBuffer(body) ? body : Buffer.from(body);
      headers = { ...headers, 'Content-Length': body.length };
    }
    const req = http.request({ host, port: 80, method, path, headers, timeout, localAddress: bind, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout} ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const json = async (host, method, path, opts) => {
  const r = await request(host, method, path, opts);
  const text = r.body.toString();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch {
    return { status: r.status, data: text };
  }
};

function multipart(field, filename, data) {
  const boundary = '----rapthooker' + createHash('md5').update(String(Date.now())).digest('hex').slice(0, 16);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, data, tail]);
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } };
}

function crc8266(d) {
  let crc = 0xffffffff;
  for (let n = 0; n < d.length; n++) {
    const c = d[n];
    for (let i = 0x80; i > 0; i >>= 1) {
      let bit = (crc & 0x80000000) !== 0;
      if (c & i) bit = !bit;
      crc = (crc << 1) >>> 0;
      if (bit) crc = (crc ^ 0x04c11db7) >>> 0;
    }
  }
  return crc >>> 0;
}

// The same checks as the firmware's ImageCheck: headers, segments, checksums, length and elf2bin's CRC.
function walk(d, at, end, app, p) {
  const segs = d[at + 1],
    entry = d.readUInt32LE(at + 4);
  const iramEnd = app ? 0x4010c000 : 0x40110000;
  if (!segs || segs > 16) p.push('bad segment count');
  if (entry < 0x40100000 || entry >= iramEnd) p.push('bad entry point');
  let pos = at + 8,
    sum = 0xef;
  for (let s = 0; s < segs && !p.length; s++) {
    const addr = d.readUInt32LE(pos),
      len = d.readUInt32LE(pos + 4);
    const ok =
      (app && addr >= 0x40201010 && addr < 0x40300000 && len <= 0x40300000 - addr) ||
      (addr >= 0x40100000 && addr < iramEnd && len <= iramEnd - addr) ||
      (addr >= 0x3ffe8000 && addr < 0x40000000 && len <= 0x40000000 - addr);
    if (!ok) p.push('segment out of range');
    else if (pos + 8 + len > end) p.push(app ? 'segment past the end' : 'boot loader too big');
    else for (let i = pos + 8; i < pos + 8 + len; i++) sum ^= d[i];
    pos += 8 + len;
  }
  while ((pos + 1) % 16) pos++;
  return { sum, at: pos };
}

function structure(d) {
  const p = [];
  if (d.length < 0x1020 || d[0] !== 0xe9) return ['not ESP8266 firmware'];
  const mode = d[2],
    sizeCode = d[3] >> 4;
  if (mode > 3) p.push('bad flash mode');
  const boot = walk(d, 0, 0x1000, false, p);
  if (p.length) return p;
  if (boot.at >= 0x1000) return ['boot loader too big'];
  if (d[boot.at] !== boot.sum) return ['bad boot loader checksum'];
  if (d[0x1000] !== 0xe9) return ['no app at 0x1000'];
  if (d[0x1002] !== mode || d[0x1003] >> 4 !== sizeCode) p.push('headers disagree');
  const app = walk(d, 0x1000, d.length, true, p);
  if (p.length) return p;
  if (app.at !== d.length - 1) return ['length does not match the segments'];
  const crcLen = d.readUInt32LE(0x1010),
    crcVal = d.readUInt32LE(0x1014);
  const hasCrc = crcLen === d.length;
  let crcXor = 0;
  for (let i = 0x1010; i < 0x1018; i++) crcXor ^= d[i];
  if (d[app.at] !== app.sum && !(hasCrc && d[app.at] === (app.sum ^ crcXor))) p.push('bad checksum');
  if (hasCrc) {
    const z = Buffer.from(d);
    z.fill(0, 0x1010, 0x1018);
    if (crc8266(z) !== crcVal) p.push("CRC doesn't match");
  }
  return p;
}

// The checks RaptHooker must make before handing an image to the stock firmware.
function checkImage(file, model = 'sdpro-240') {
  const data = readFileSync(file);
  const problems = structure(data);
  if (data.length > SAFE_LIMIT) problems.push(`size ${data.length} over ${SAFE_LIMIT} (stock drops bytes past ${STOCK_OTA_LIMIT})`);
  if (data[2] !== 2) problems.push(`flash mode ${data[2]} is not DIO`);
  if (data[3] >> 4 !== 4) problems.push('flash size in header is not 4 MB');
  if (data.readUInt32LE(0x1010) !== data.length) problems.push('no build CRC');
  if (!data.includes(Buffer.from(`RHSCREEN-FW:${model}:`))) problems.push('RaptHooker firmware marker missing');
  const md5 = createHash('md5').update(data).digest('hex');
  return { data, md5, problems };
}

async function identify(host) {
  const facts = {};
  const mac = await request(host, 'GET', '/mac', { timeout: 5000 });
  facts.mac = mac.body.toString().trim();
  const cfg = await json(host, 'GET', '/config', { timeout: 5000 });
  facts.config = cfg.data;
  const root = await request(host, 'GET', '/', { timeout: 5000 });
  facts.title = /<title>([^<]*)<\/title>/.exec(root.body.toString())?.[1];
  const ok =
    /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(facts.mac) &&
    typeof cfg.data === 'object' &&
    ['gifnum', 'theme', 'brightness', 'freespace', 'weatherkey'].every((k) => k in cfg.data) &&
    /Smart Weather Clock/i.test(facts.title ?? '');
  return { ok, ...facts };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd, ...args] = process.argv.slice(2).map((a) => (a.startsWith('@') ? readFileSync(a.slice(1), 'utf8') : a));

if (cmd === 'identify') {
  console.log(JSON.stringify(await identify(args[0] ?? '192.168.4.1'), null, 2));
} else if (cmd === 'check') {
  const { data, md5, problems } = checkImage(args[0]);
  console.log({ size: data.length, md5, problems });
} else if (cmd === 'flash-stock') {
  const host = args[1] ?? '192.168.4.1';
  const { data, md5, problems } = checkImage(args[0]);
  if (problems.length) throw new Error('refusing: ' + problems.join('; '));
  const who = await identify(host);
  if (!who.ok) throw new Error('not a supported stock screen: ' + JSON.stringify(who));
  let name = basename(args[0]);
  if (!name.startsWith('SDP')) name = 'SDP-' + name;
  const { body, headers } = multipart('update', name, data);
  console.log(`uploading ${data.length} bytes (md5 ${md5}) to ${who.mac} as ${name}`);
  const t = Date.now();
  const r = await request(host, 'POST', '/update_ota', { headers, body, timeout: 120000 });
  console.log(`stock said ${r.status} ${JSON.stringify(r.body.toString())} after ${Date.now() - t} ms`);
  process.exitCode = r.status === 200 && r.body.toString().trim() === 'OK' ? 0 : 1;
} else if (cmd === 'info') {
  console.log(JSON.stringify((await json(args[0] ?? '192.168.4.1', 'GET', '/api/info')).data, null, 2));
} else if (cmd === 'setup') {
  const [host, raw] = args;
  const b = JSON.parse(raw);
  if (b.passwordFile) {
    b.password = readFileSync(b.passwordFile, 'utf8').replace(/\r?\n$/, '');
    delete b.passwordFile;
  }
  const body = JSON.stringify(b);
  const r = await json(host, 'POST', '/api/setup', {
    headers: { 'Content-Type': 'application/json' },
    body: body,
  });
  console.log('setup:', r.status, r.data);
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    try {
      const s = await json(host, 'GET', '/api/setup', { timeout: 3000 });
      console.log(new Date().toISOString().slice(11, 19), JSON.stringify(s.data));
      if (s.data.trial === 'connected' && s.data.saved) break;
      if (s.data.trial === 'failed') break;
    } catch (e) {
      console.log(new Date().toISOString().slice(11, 19), 'unreachable:', e.message);
    }
  }
} else if (cmd === 'finish') {
  const [host, token] = args;
  console.log(await json(host, 'POST', '/api/setup/finish', { headers: { Authorization: `Bearer ${token}` } }));
} else if (cmd === 'settings') {
  const [host, token, raw] = args;
  const b = JSON.parse(raw);
  if (b.passwordFile) {
    b.password = readFileSync(b.passwordFile, 'utf8').replace(/\r?\n$/, '');
    delete b.passwordFile;
  }
  const body = JSON.stringify(b);
  console.log(
    await json(host, 'POST', '/api/settings', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    }),
  );
} else if (cmd === 'ota') {
  const [host, token, file, force] = args;
  const { data, md5, problems } = checkImage(file);
  if (problems.length && force !== 'force') throw new Error('refusing: ' + problems.join('; '));
  const { body, headers } = multipart('firmware', basename(file), data);
  const q = `?size=${data.length}&md5=${md5}${force === 'force' ? '&force=1' : ''}`;
  const t = Date.now();
  const r = await json(host, 'POST', '/api/ota' + q, {
    headers: { ...headers, Authorization: `Bearer ${token}` },
    body,
    timeout: 120000,
  });
  console.log(`ota ${r.status} ${JSON.stringify(r.data)} after ${Date.now() - t} ms`);
} else if (cmd === 'call') {
  const [host, token, method, path, body] = args;
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await request(host, method, path, { headers, body });
  console.log(r.status, r.body.toString());
} else {
  console.log('see the usage at the top of the file');
}
