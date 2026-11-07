import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, MIN_SCHEMA_KEY } from '../db.js';

/**
 * Rules every version keeps so that people can switch between any two releases (betas included), in either direction,
 * without losing data: see docs/data-compatibility.md. scripts/release-compat.mjs runs the published releases
 * themselves against what this version leaves.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });

/** The release tags (v0.3.0, v0.9.0-beta.1...) in this clone, or null without git. */
function releaseTags(): string[] | null {
  try {
    return git('tag', '--list', 'v*')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Each tag's src/server/db.ts, read in one go (null where that release had none). */
function dbSources(list: string[]): Map<string, string | null> {
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: `${list.map((t) => `${t}:src/server/db.ts`).join('\n')}\n`,
    maxBuffer: 256 << 20,
  });
  const sources = new Map<string, string | null>();
  let at = 0;
  for (const tag of list) {
    // "<object> blob <size>", then that many bytes and a newline; or "<name> missing".
    const eol = out.indexOf(0x0a, at);
    const header = /^\S+ blob (\d+)$/.exec(out.subarray(at, eol).toString('utf8'));
    at = eol + 1;
    if (!header) {
      sources.set(tag, null);
      continue;
    }
    const size = Number(header[1]);
    sources.set(tag, out.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return sources;
}

/** MIGRATIONS as a release's db.ts has it. */
function migrationsIn(tag: string, source: string): string[] {
  const file = ts.createSourceFile('db.ts', source, ts.ScriptTarget.Latest, true);
  let found: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'MIGRATIONS' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found = node.initializer.elements.map((e, i) => {
        if (ts.isNoSubstitutionTemplateLiteral(e) || ts.isStringLiteral(e)) return e.text;
        throw new Error(`${tag}: migration ${i + 1} isn't a plain string, so it can't be compared`);
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`${tag}: no MIGRATIONS in src/server/db.ts`);
  return found;
}

const tags = releaseTags();

describe('every release', () => {
  // CI must see the tags (actions/checkout with fetch-depth: 0), or this would pass without checking anything.
  it.runIf(Boolean(process.env.CI))('has its tags in this clone', () => {
    expect(tags, 'git tags missing: check out with fetch-depth: 0').not.toBeNull();
    expect(tags!.length, 'no release tags: check out with fetch-depth: 0').toBeGreaterThan(0);
  });

  it.runIf(Boolean(tags?.length))("still has its migrations, unchanged and in order, at the start of this version's", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const [tag, source] of dbSources(tags!)) {
      if (source === null) continue;
      const released = migrationsIn(tag, source);
      checked++;
      if (released.length > MIGRATIONS.length) {
        problems.push(`${tag} has ${released.length} migrations and this version only ${MIGRATIONS.length}: one was removed`);
      }
      released.forEach((sql, i) => {
        if (MIGRATIONS[i] !== sql) {
          problems.push(`migration ${i + 1} isn't the one ${tag} released: put the change in a new migration at the end instead`);
        }
      });
    }
    expect(checked, "no release's db.ts could be read from git").toBeGreaterThan(0);
    expect([...new Set(problems)], 'released migrations must never change (docs/data-compatibility.md)').toEqual([]);
  });
});

describe('going back to an older release', () => {
  it('is never ruled out by a migration (minSchema)', () => {
    const setting = MIGRATIONS.map((sql, i) => (sql.includes(MIN_SCHEMA_KEY) ? i + 1 : 0)).filter(Boolean);
    expect(setting, `migrations that set ${MIN_SCHEMA_KEY}: older releases would refuse the database`).toEqual([]);
  });

  it('is never ruled out by the server setting minSchema', () => {
    const server = join(ROOT, 'src', 'server');
    const files = readdirSync(server, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.split(/[\\/]/).includes('test') && !f.split(/[\\/]/).includes('dist'),
    );
    const writers = files.filter((f) => /setMeta\(\s*(MIN_SCHEMA_KEY|['"`]minSchema['"`])/.test(readFileSync(join(server, f), 'utf8')));
    expect(
      writers.map((f) => relative(ROOT, join(server, f))),
      `code that sets ${MIN_SCHEMA_KEY}`,
    ).toEqual([]);
  });
});
