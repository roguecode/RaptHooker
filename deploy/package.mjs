// Packages a built RaptHooker for release, the same way for CI and for you:
//   npm run package                 builds, then packages
//   node deploy/package.mjs         packages what's already built (npm run build first)
// Options: --out DIR (default release), --notes FILE (writes this version's CHANGELOG section, the release text).
//
// Writes DIR/rapthooker-<version>.tar.gz, DIR/SHA256SUMS and DIR/install.sh. The archive has the layout deploy.ps1
// stages (server/*.cjs, web/dist, deploy/pi with LF line endings) plus deploy/install.sh, LICENSE, README.md,
// CHANGELOG.md, attribution.md and VERSION. install.sh unpacks it into /opt/rapthooker.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) fail(`--${name} needs a value`);
  return value;
}

/** The "## [version] - date" section of a Keep a Changelog file, without its heading and link definitions. */
export function changelogSection(markdown, version) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?v?${version.replace(/[.+]/g, '\\$&')}\\]?(\\s|$)`).test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((l) => !/^ {0,3}\[[^\]]+\]:\s/.test(l))
    .join('\n')
    .trim();
}

/** Copies a folder of scripts and unit files with LF line endings (Windows checkouts may have CRLF). */
function copyText(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyText(join(from, name), join(to, name));
    return;
  }
  const data = readFileSync(from);
  writeFileSync(to, data.includes(0) ? data : data.toString('utf8').replace(/\r\n/g, '\n'));
  if (process.platform !== 'win32' && /\.sh$/.test(to)) chmodSync(to, 0o755);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main() {
  const out = resolve(root, option('out') ?? 'release');
  const notes = option('notes');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const serverDist = join(root, 'src', 'server', 'dist');
  const webDist = join(root, 'src', 'web', 'dist');
  if (!existsSync(join(serverDist, 'rapthooker.cjs')) || !existsSync(join(webDist, 'index.html'))) {
    fail('nothing built yet: run npm run build first (or npm run package, which does both)');
  }

  let section = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!section) {
    if (!version.includes('-')) fail(`CHANGELOG.md has no section for ${version}: add one before releasing`);
    section = `Pre-release of RaptHooker ${version.replace(/-.*$/, '')}, for testing.`;
  }

  const name = `rapthooker-${version}`;
  const stage = join(out, name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'server'), { recursive: true });
  mkdirSync(join(stage, 'web'), { recursive: true });
  mkdirSync(join(stage, 'deploy'), { recursive: true });
  for (const file of readdirSync(serverDist)) if (file.endsWith('.cjs')) cpSync(join(serverDist, file), join(stage, 'server', file));
  cpSync(webDist, join(stage, 'web', 'dist'), { recursive: true });
  copyText(join(root, 'deploy', 'pi'), join(stage, 'deploy', 'pi'));
  copyText(join(root, 'deploy', 'install.sh'), join(stage, 'deploy', 'install.sh'));
  for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md', 'attribution.md']) cpSync(join(root, file), join(stage, file));
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);

  const archive = `${name}.tar.gz`;
  rmSync(join(out, archive), { force: true });
  const gnu = /GNU tar/.test(execFileSync('tar', ['--version'], { encoding: 'utf8' }));
  // GNU tar (Linux, CI) can leave out who built it; Windows' and macOS's tar don't have these options.
  const owner = gnu ? ['--owner=0', '--group=0', '--numeric-owner', '--sort=name'] : [];
  execFileSync('tar', [...owner, '-czf', archive, '-C', name, '.'], { cwd: out, stdio: 'inherit' });

  copyText(join(root, 'deploy', 'install.sh'), join(out, 'install.sh'));
  const sums = [archive, 'install.sh'].map((file) => `${sha256(join(out, file))}  ${file}\n`).join('');
  writeFileSync(join(out, 'SHA256SUMS'), sums);
  if (notes) writeFileSync(resolve(root, notes), `${section}\n`);

  console.log(`Packaged RaptHooker ${version}:`);
  for (const file of [archive, 'SHA256SUMS', 'install.sh']) console.log(`  ${join(out, file)}`);
  if (notes) console.log(`  ${resolve(root, notes)} (release notes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
