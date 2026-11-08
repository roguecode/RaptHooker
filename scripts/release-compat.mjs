// Proves that people can switch between any two releases of RaptHooker, betas included, in either direction, without
// losing or changing anything (see docs/data-compatibility.md). It runs the published releases themselves against the
// data this version leaves, and this version against theirs:
//
//   npm run build && npm run test:compat                 every release tag in this clone (unpublished ones are skipped)
//   npm run test:compat -- --releases 0.7.0,0.8.0        just these
//   npm run test:compat -- --keep                        keep the data folders and logs to look at
//
// For each release, one data folder goes through: the release sets up a hub and records -> this version upgrades it
// and records -> the release runs on it again (going back) and records -> this version again. Each one has to start,
// answer, show the pills and brew, and record; after each, every table, column, reading, device, brew and hub setting
// that was there must still be there, unchanged. Releases are downloaded from GitHub (checked against their
// SHA256SUMS) and kept in node_modules/.cache/rapthooker-releases.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = 'roguecode/RaptHooker';
const CURRENT = {
  name: 'this version',
  server: join(ROOT, 'src', 'server', 'dist', 'rapthooker.cjs'),
  webDir: join(ROOT, 'src', 'web', 'dist'),
};
const CACHE = join(ROOT, 'node_modules', '.cache', 'rapthooker-releases');
/** Simulated pills: every release's mock Bluetooth has them, at these addresses. */
const PILLS = ['F0:0D:5E:ED:00:03', 'F0:0D:5E:ED:00:04'];
/** The simulated RAPT Thermometer: a kind of device older releases don't know. */
const THERMOMETER = 'F0:0D:5E:ED:00:10';
const START_TIMEOUT_MS = 90_000;
const RECORD_TIMEOUT_MS = 75_000;

const { values: args } = parseArgs({
  options: {
    releases: { type: 'string' },
    jobs: { type: 'string', default: '3' },
    keep: { type: 'boolean', default: false },
  },
});

function fail(message) {
  console.error(`release-compat: ${message}`);
  process.exit(1);
}

/** The release versions to try: every v* tag (but one on this very commit, which is the build being tested). */
function releasesToTry() {
  if (args.releases)
    return args.releases
      .split(',')
      .map((v) => v.trim().replace(/^v/, ''))
      .filter(Boolean);
  const git = (...a) =>
    execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  let tags;
  try {
    tags = git('tag', '--list', 'v*', '--sort=v:refname');
  } catch {
    fail("couldn't list the release tags: run it in a git clone, or name the releases with --releases");
  }
  const here = new Set(git('tag', '--points-at', 'HEAD'));
  const versions = tags.filter((t) => !here.has(t)).map((t) => t.slice(1));
  if (!versions.length) fail('no release tags in this clone (fetch them: git fetch --tags, or fetch-depth: 0 in CI)');
  return versions;
}

/** A tag without a published release (yet): no hub can run it, so there's nothing to switch to and from. */
class NotPublished extends Error {}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (res.status === 404) throw new NotPublished(`it has no published release yet (${url} isn't there)`);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A published release, unpacked (downloaded and checked the first time). */
async function release(version) {
  const dir = join(CACHE, version);
  const done = join(dir, '.complete');
  if (existsSync(done)) return { name: version, server: join(dir, 'server', 'rapthooker.cjs') };
  const name = `rapthooker-${version}.tar.gz`;
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const [archive, sums] = await Promise.all([download(`${base}/${name}`), download(`${base}/SHA256SUMS`)]);
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name || file === `*${name}`)?.[0];
  if (!expected) throw new Error(`the SHA256SUMS of v${version} doesn't list ${name}`);
  if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error(`${name} doesn't match its checksum`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), archive);
  // A relative path, so no tar mistakes C:\ for a remote host.
  execFileSync('tar', ['-xzf', name], { cwd: dir });
  rmSync(join(dir, name));
  if (!existsSync(join(dir, 'server', 'rapthooker.cjs'))) throw new Error(`${name} has no server/rapthooker.cjs`);
  writeFileSync(done, `${new Date().toISOString()}\n`);
  return { name: version, server: join(dir, 'server', 'rapthooker.cjs') };
}

function freePort() {
  return new Promise((ok, no) => {
    const s = createServer();
    s.unref();
    s.on('error', no);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** A hub stopped while starting because another process took its port first (see start). */
class PortTaken extends Error {}

/**
 * Starts a hub (a release, or this version) on a data folder, with simulated devices, and waits until it answers.
 * freePort() can only find a port that's free now: another hub starting alongside (or anything else) can take it before
 * this one listens, which every version does only after opening (and upgrading) the database. So a hub that stops
 * because its port was taken is started again on another, a few times; anything else fails as it is.
 */
async function start(app, home, step) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce(app, home, step, attempt);
    } catch (err) {
      if (!(err instanceof PortTaken) || attempt >= 3) throw err;
    }
  }
}

async function startOnce(app, home, step, attempt) {
  const port = await freePort();
  const config = join(home, `${step}.config.json`);
  writeFileSync(
    config,
    JSON.stringify({
      host: '127.0.0.1',
      port,
      dataDir: join(home, 'data'),
      ...(app.webDir ? { webDir: app.webDir } : {}),
      bluetooth: { mock: true },
      auth: { trustLocalhost: true },
      clock: { maxSyncWaitMin: 0 },
      screens: { wifi: 'mock', usb: 'mock' },
    }),
  );
  const logFile = join(home, `${step}.log`);
  // A second try goes on in the same log, after the first.
  const log = createWriteStream(logFile, { flags: attempt > 1 ? 'a' : 'w' });
  const child = spawn(process.execPath, [app.server], {
    cwd: home,
    env: { ...process.env, RAPTHOOKER_CONFIG: config, RAPTHOOKER_PORT: String(port), RAPTHOOKER_DATA_DIR: join(home, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let errors = '';
  child.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-4000)));
  let exited = null;
  const gone = new Promise((ok) => child.on('exit', (code, signal) => ok((exited = signal ?? code))));
  // After 'exit', once everything it wrote has been read.
  const closed = new Promise((ok) => child.on('close', ok));
  const hub = { app, port, child, gone, logFile, step, exited: () => exited };
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (exited !== null) {
      await closed;
      if (errors.includes('EADDRINUSE')) throw new PortTaken(`${app.name} couldn't listen on port ${port}: see ${logFile}`);
      throw new Error(`${app.name} stopped while starting (${exited}): see ${logFile}`);
    }
    let status;
    try {
      status = await api(hub, 'GET', '/api/status');
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`${app.name} didn't answer within ${START_TIMEOUT_MS / 1000} s: see ${logFile}`, { cause: err });
      }
      await sleep(300);
      continue;
    }
    if (app !== CURRENT && status.version !== app.name) throw new Error(`expected ${app.name} to answer, but ${status.version} did`);
    return hub;
  }
}

async function stop(hub) {
  if (hub.exited() === null) {
    hub.child.kill('SIGTERM');
    const killed = await Promise.race([hub.gone.then(() => true), sleep(15_000).then(() => false)]);
    if (!killed) {
      hub.child.kill('SIGKILL');
      await hub.gone;
    }
  }
  // Let go of the database files (Windows).
  await sleep(500);
}

async function api(hub, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${hub.app.name}: ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Waits until the hub hears these devices (it adds only what it has heard). */
async function waitNearby(hub, addresses) {
  const deadline = Date.now() + RECORD_TIMEOUT_MS;
  for (;;) {
    const state = await api(hub, 'GET', '/api/state');
    const heard = new Set([...(state.nearby ?? []), ...(state.pills ?? [])].map((n) => n.address));
    if (addresses.every((a) => heard.has(a))) return;
    if (Date.now() > deadline) throw new Error(`${hub.app.name} didn't hear ${addresses.join(', ')}`);
    await sleep(500);
  }
}

function readingCounts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return new Map(
      db
        .prepare('SELECT pill_id AS id, COUNT(*) AS n FROM readings GROUP BY pill_id')
        .all()
        .map((r) => [r.id, r.n]),
    );
  } finally {
    db.close();
  }
}

/** Waits until each pill has a reading it didn't have before: the hub records with this data. */
async function waitForReadings(hub, file, ids, before) {
  const deadline = Date.now() + RECORD_TIMEOUT_MS;
  for (;;) {
    if (hub.exited() !== null) throw new Error(`${hub.app.name} stopped (${hub.exited()}): see ${hub.logFile}`);
    let counts = new Map();
    try {
      counts = readingCounts(file);
    } catch {
      // The hub is busy with it; look again.
    }
    if (ids.every((id) => (counts.get(id) ?? 0) > (before?.readingsBy.get(id) ?? 0))) return;
    if (Date.now() > deadline)
      throw new Error(`${hub.app.name} recorded nothing for ${ids.join(', ')} within ${RECORD_TIMEOUT_MS / 1000} s`);
    await sleep(1000);
  }
}

/** The hub shows the devices and the brew, and their history, as it should. */
async function expectData(hub, ids, brewId) {
  const pills = await api(hub, 'GET', '/api/pills');
  const now = Date.now();
  for (const id of ids) {
    if (!pills.some((p) => p.id === id)) throw new Error(`${hub.app.name} doesn't list pill ${id}`);
    await api(hub, 'GET', `/api/pills/${encodeURIComponent(id)}/history?from=${now - 7 * 86_400_000}&to=${now}`);
  }
  const brews = await api(hub, 'GET', '/api/brews');
  const list = Array.isArray(brews) ? brews : (brews.brews ?? brews.items ?? []);
  if (!list.some((b) => b.id === brewId)) throw new Error(`${hub.app.name} doesn't list the brew`);
  await api(hub, 'GET', `/api/brews/${encodeURIComponent(brewId)}`);
  await api(hub, 'GET', '/api/settings/hub');
}

/** What's in the database: everything that must come through every switch. */
function snapshot(file) {
  // Read-write, so what a hub that was stopped left in the write-ahead log is folded in.
  const db = new DatabaseSync(file);
  try {
    const all = (sql) => db.prepare(sql).all();
    const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
    const columns = Object.fromEntries(tables.map((t) => [t, all(`PRAGMA table_info("${t}")`).map((c) => c.name)]));
    const counts = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
    const readings = new Map(
      all('SELECT pill_id, ts, sg, temp, battery FROM readings').map((r) => [`${r.pill_id} at ${r.ts}`, [r.sg, r.temp, r.battery]]),
    );
    const readingsBy = new Map(all('SELECT pill_id AS id, COUNT(*) AS n FROM readings GROUP BY pill_id').map((r) => [r.id, r.n]));
    const pills = new Map(
      all('SELECT id, address, json FROM pills').map((r) => [r.id, { address: r.address, settings: JSON.parse(r.json) }]),
    );
    const brews = new Map(
      all('SELECT id, pill_id, started_at, ended_at, json FROM brews').map((r) => [
        r.id,
        { pill: r.pill_id, startedAt: r.started_at, endedAt: r.ended_at, settings: JSON.parse(r.json) },
      ]),
    );
    const hub = db.prepare("SELECT value FROM meta WHERE key = 'hub'").get();
    return {
      schema: db.prepare('PRAGMA user_version').get().user_version,
      tables,
      columns,
      counts,
      readings,
      readingsBy,
      pills,
      brews,
      hub: hub ? JSON.parse(hub.value) : null,
    };
  } finally {
    db.close();
  }
}

/** Everything in `a` is in `b` as it was (`b` may have more). */
function kept(a, b, path, problems) {
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of Object.keys(a)) {
      if (!(key in b)) problems.push(`${path}.${key} was lost`);
      else kept(a[key], b[key], `${path}.${key}`, problems);
    }
  } else if (!isDeepStrictEqual(a, b)) {
    problems.push(`${path} changed from ${JSON.stringify(a)} to ${JSON.stringify(b)}`);
  }
}

/** What was lost or changed between two snapshots. */
function compare(before, after) {
  const problems = [];
  if (after.schema < before.schema) problems.push(`the schema went back from ${before.schema} to ${after.schema}`);
  for (const table of before.tables) {
    if (!after.tables.includes(table)) {
      problems.push(`table ${table} was dropped`);
      continue;
    }
    for (const column of before.columns[table]) {
      if (!after.columns[table].includes(column)) problems.push(`column ${table}.${column} was dropped`);
    }
    if (after.counts[table] < before.counts[table])
      problems.push(`${table} went from ${before.counts[table]} rows to ${after.counts[table]}`);
  }
  const readings = [];
  for (const [key, values] of before.readings) {
    const now = after.readings.get(key);
    if (!now) readings.push(`${key} was lost`);
    else if (!isDeepStrictEqual(values, now)) readings.push(`${key} changed from ${values} to ${now}`);
  }
  if (readings.length) problems.push(`${readings.length} reading(s) lost or changed, e.g. ${readings.slice(0, 3).join('; ')}`);
  for (const [id, pill] of before.pills) {
    const now = after.pills.get(id);
    if (!now) problems.push(`device ${id} was lost`);
    else {
      if (now.address !== pill.address) problems.push(`device ${id}'s address changed from ${pill.address} to ${now.address}`);
      kept(pill.settings, now.settings, `device ${id}`, problems);
    }
  }
  for (const [id, brew] of before.brews) {
    const now = after.brews.get(id);
    if (!now) problems.push(`brew ${id} was lost`);
    else kept(brew, now, `brew ${id}`, problems);
  }
  kept(before.hub, after.hub, 'hub settings', problems);
  return problems;
}

/** One release, there and back again with this version. */
async function scenario(app) {
  const home = mkdtempSync(join(tmpdir(), `rapthooker-compat-${app.name}-`));
  const file = join(home, 'data', 'rapthooker.db');
  const passed = [];
  let hub = null;
  const run = async (step, who, work) => {
    hub = await start(who, home, step);
    try {
      await work(hub);
    } finally {
      await stop(hub);
      hub = null;
    }
  };
  try {
    // 1. The release sets up a hub: two pills, a brew, the hub's name.
    let ids = [];
    let brewId = null;
    await run('1-release', app, async (h) => {
      await waitNearby(h, PILLS);
      for (const [i, address] of PILLS.entries()) ids.push((await api(h, 'POST', '/api/pills', { address, name: `Compat ${i + 1}` })).id);
      brewId = (await api(h, 'POST', '/api/brews', { pillId: ids[0], name: 'Compat brew' })).id;
      await api(h, 'PUT', '/api/settings/hub', { ...(await api(h, 'GET', '/api/settings/hub')), name: 'Compat hub' });
      await waitForReadings(h, file, ids, null);
    });
    let before = snapshot(file);
    passed.push(`${app.name} set up a hub (schema ${before.schema})`);

    // 2. This version takes it over: upgrades it, saves the hub settings, adds a device the release doesn't know.
    await run('2-this-version', CURRENT, async (h) => {
      await expectData(h, ids, brewId);
      await api(h, 'PUT', '/api/settings/hub', await api(h, 'GET', '/api/settings/hub'));
      await waitNearby(h, [THERMOMETER]);
      await api(h, 'POST', '/api/pills', { address: THERMOMETER, name: 'Compat thermometer' });
      await waitForReadings(h, file, ids, before);
    });
    let after = snapshot(file);
    let problems = compare(before, after);
    if (problems.length) throw new Error(`going from ${app.name} to this version:\n  ${problems.join('\n  ')}`);
    passed.push(`this version upgraded it (schema ${after.schema}) and kept everything`);
    before = after;

    // 3. Back to the release, which has to run on what this version left, and record into it.
    await run('3-back-to-release', app, async (h) => {
      await expectData(h, ids, brewId);
      await waitForReadings(h, file, ids, before);
    });
    after = snapshot(file);
    problems = compare(before, after);
    if (problems.length) throw new Error(`going back from this version to ${app.name}:\n  ${problems.join('\n  ')}`);
    passed.push(`${app.name} ran on it again and kept everything`);
    before = after;

    // 4. And forward again.
    await run('4-this-version-again', CURRENT, async (h) => {
      await expectData(h, ids, brewId);
      await waitForReadings(h, file, ids, before);
    });
    after = snapshot(file);
    problems = compare(before, after);
    if (problems.length) throw new Error(`going from ${app.name} to this version again:\n  ${problems.join('\n  ')}`);
    passed.push('this version took it back and kept everything');
    if (!args.keep) rmSync(home, { recursive: true, force: true });
    return { name: app.name, ok: true, passed, home };
  } catch (err) {
    if (hub) await stop(hub).catch(() => undefined);
    return { name: app.name, ok: false, passed, error: err.message, home };
  }
}

async function main() {
  if (!existsSync(CURRENT.server) || !existsSync(join(CURRENT.webDir, 'index.html'))) {
    fail('this test runs the built app: run `npm run build` first');
  }
  const versions = releasesToTry();
  console.log(`Trying ${versions.length} release(s) against this version: ${versions.join(', ')}`);
  const queue = [...versions];
  const results = [];
  const jobs = Math.max(1, Number(args.jobs) || 1);
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let version = queue.shift(); version; version = queue.shift()) {
        let result;
        try {
          result = await scenario(await release(version));
        } catch (err) {
          // Tagged but not published (the release workflow is still running, or failed): no hub has it.
          result =
            err instanceof NotPublished
              ? { name: version, ok: true, skipped: err.message, passed: [], home: null }
              : { name: version, ok: false, passed: [], error: err.message, home: null };
        }
        results.push(result);
        console.log(`${result.skipped ? 'skip' : result.ok ? 'ok  ' : 'FAIL'} ${version}`);
      }
    }),
  );

  results.sort((a, b) => versions.indexOf(a.name) - versions.indexOf(b.name));
  console.log('');
  for (const r of results) {
    console.log(`${r.skipped ? '-' : r.ok ? '✓' : '✗'} ${r.name}`);
    if (r.skipped) console.log(`    skipped: ${r.skipped}`);
    for (const p of r.passed) console.log(`    ${p}`);
    if (!r.ok) {
      console.log(`    ${r.error.replace(/\n/g, '\n    ')}`);
      if (r.home) console.log(`    data and logs: ${r.home}`);
    } else if (args.keep && r.home) console.log(`    data and logs: ${r.home}`);
  }
  const failed = results.filter((r) => !r.ok);
  const tried = results.filter((r) => !r.skipped);
  if (failed.length) {
    console.log(`\n${failed.length} of ${tried.length} release(s) can't be switched to and from this version without problems.`);
    for (const r of failed) {
      if (!r.home) continue;
      for (const step of ['1-release', '2-this-version', '3-back-to-release', '4-this-version-again']) {
        const log = join(r.home, `${step}.log`);
        if (!existsSync(log)) continue;
        const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-15);
        console.log(`\n--- ${r.name}: ${step}.log (last lines)\n${tail.join('\n')}`);
      }
    }
    // Not process.exit(): downloads may still have connections open, and exiting under them can crash Node on Windows.
    process.exitCode = 1;
    return;
  }
  if (!tried.length) {
    console.error('release-compat: none of the releases has been published, so nothing was tried');
    process.exitCode = 1;
    return;
  }
  const skipped = results.length - tried.length;
  console.log(
    `\nAll ${tried.length} published release(s) switch to and from this version without losing or changing anything.` +
      (skipped ? ` (${skipped} tag(s) without a published release skipped.)` : ''),
  );
}

await main();
