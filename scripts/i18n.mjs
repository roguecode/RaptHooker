// Finds the text to translate in the web app and checks every catalogue.
//   node scripts/i18n.mjs          writes src/web/app/i18n/source.json and prints a summary
//   node scripts/i18n.mjs --check  also fails (exit 1) on untranslatable t() calls or broken placeholders
//   node scripts/i18n.mjs --strict also fails when a catalogue is missing strings
//   node scripts/i18n.mjs --prune  removes strings from catalogues that the app no longer uses
// Text is found in t('...'), tk('...'), tc('context', '...') (key "context::text") and tp(n, '...', '...') calls with
// plain string literals.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// I18N_APP points the script at another folder (for testing it).
const APP = process.env.I18N_APP ?? join(ROOT, 'src/web/app');
const I18N = join(APP, 'i18n');
const LOCALES = join(I18N, 'locales');
const args = new Set(process.argv.slice(2));

const STR = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|\x60((?:[^\x60\\$]|\\.)*)\x60`;
const CALL = new RegExp(String.raw`\b(t|tk)\(\s*(?:${STR})\s*[,)]`, 'g');
const PLURAL = new RegExp(String.raw`\btp\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*(?:${STR})\s*,\s*(?:${STR})\s*[,)]`, 'g');
const CONTEXT = new RegExp(String.raw`\btc\(\s*(?:${STR})\s*,\s*(?:${STR})\s*[,)]`, 'g');
const DYNAMIC = /\bt\(\s*\x60[^\x60]*\$\{/g;

const unescape = (s) => JSON.parse(`"${s.replace(/\\(['"\x60])/g, '$1').replace(/"/g, '\\"')}"`);
const literal = (m, i) => unescape(m[i] ?? m[i + 1] ?? m[i + 2] ?? '');
const placeholders = (s) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path !== I18N) yield* files(path);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}

const source = new Map();
const problems = [];
const add = (key, file, plural) => {
  const entry = source.get(key) ?? { files: new Set(), plural };
  entry.files.add(file);
  source.set(key, entry);
};

for (const path of files(APP)) {
  const text = readFileSync(path, 'utf8');
  const file = relative(APP, path).replace(/\\/g, '/');
  for (const m of text.matchAll(CALL)) add(literal(m, 2), file, false);
  for (const m of text.matchAll(PLURAL)) add(`${literal(m, 1)}|${literal(m, 4)}`, file, true);
  for (const m of text.matchAll(CONTEXT)) add(`${literal(m, 1)}::${literal(m, 4)}`, file, false);
  for (const m of text.matchAll(DYNAMIC)) {
    const line = text.slice(0, m.index).split('\n').length;
    problems.push(`${file}:${line}: t() with \${...} can't be translated; use t('... {name} ...', { name })`);
  }
}

const sorted = [...source.entries()].sort(([a], [b]) => a.localeCompare(b));
const out = Object.fromEntries(sorted.map(([k, v]) => [k, { files: [...v.files].sort(), ...(v.plural ? { plural: true } : {}) }]));
writeFileSync(join(I18N, 'source.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`${sorted.length} strings to translate (src/web/app/i18n/source.json)`);

let failed = problems.length > 0;
for (const p of problems) console.error(p);

for (const name of readdirSync(LOCALES)
  .filter((n) => n.endsWith('.json'))
  .sort()) {
  const path = join(LOCALES, name);
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  const missing = [];
  const broken = [];
  for (const [key, { plural }] of sorted) {
    const value = catalog[key];
    if (value === undefined || value === '') {
      missing.push(key);
      continue;
    }
    if (plural) {
      const [one, other] = key.split('|');
      if (typeof value !== 'object' || !value.other) broken.push(`${key}: needs an object with at least "other"`);
      else
        for (const [cat, text] of Object.entries(value)) {
          const want = placeholders(cat === 'one' ? one : other)
            .replace('count', '')
            .replace(/^,|,$/g, '');
          const got = placeholders(text).replace('count', '').replace(/^,|,$/g, '');
          if (want !== got) broken.push(`${key} [${cat}]: placeholders {${got}} should be {${want}}`);
        }
    } else if (typeof value !== 'string') broken.push(`${key}: should be a string`);
    else if (placeholders(value) !== placeholders(key))
      broken.push(`${key}: placeholders {${placeholders(value)}} should be {${placeholders(key)}}`);
  }
  const stale = Object.keys(catalog).filter((k) => !source.has(k));
  if (args.has('--prune') && stale.length) {
    for (const k of stale) delete catalog[k];
    writeFileSync(path, JSON.stringify(catalog, null, 2) + '\n');
  }
  console.log(`${name}: ${sorted.length - missing.length}/${sorted.length} translated, ${broken.length} broken, ${stale.length} unused`);
  for (const b of broken) console.error(`  ${name}: ${b}`);
  if (missing.length && args.has('--verbose')) for (const m of missing) console.log(`  missing: ${m}`);
  if (broken.length || (missing.length && args.has('--strict'))) failed = true;
}

if ((args.has('--check') || args.has('--strict')) && failed) process.exit(1);
