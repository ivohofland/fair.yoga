/**
 * Pins that the modules a client component imports for the class instants stay
 * free of server-only code. `next build` rejects a client import of
 * `server-only` modules only once the leak exists, and a transitive one is the
 * kind a refactor adds without looking.
 */
import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

const CLIENT_IMPORTED = [
  'src/lib/class-start.ts',
  'src/lib/cancel-deadline.ts',
  'src/lib/cancel-check.ts',
  'src/lib/late-publish.ts',
  'src/components/class/class-edit-form.tsx',
  'src/components/settings/late-first-class-notice.tsx',
];

// Exempt from the "nothing under src/services" rule only: the walk still reads
// these files' imports, so a service that stays client-safe is held to that by
// what it imports rather than by this list.
const PURE_SERVICES = ['src/services/pricing.ts'];

const FORBIDDEN_FILES = ['src/lib/log.ts', 'src/lib/degradation.ts', 'src/lib/db.ts'];

function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    base,
  ]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/** Runtime import specifiers: `import type` and `export type` are erased. */
function runtimeSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const node of sf.statements) {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly) continue;
      if (ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (node.isTypeOnly) continue;
      if (ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    }
  }
  return out;
}

/** Every forbidden module reachable at runtime from `entry`, with the chain that reaches it. */
function forbiddenReached(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const rel = path.relative(ROOT, file);
    const here = [...chain, rel];
    const underServices = rel.startsWith(`src${path.sep}services${path.sep}`);
    if (FORBIDDEN_FILES.includes(rel) || (underServices && !PURE_SERVICES.includes(rel))) {
      found.push(here.join(' -> '));
      return;
    }
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier === 'server-only') {
        found.push([...here, 'server-only'].join(' -> '));
        continue;
      }
      const resolved = resolveSpecifier(file, specifier);
      if (resolved) walk(resolved, here);
    }
  };
  walk(path.join(ROOT, entry), []);
  return found;
}

describe('the modules a client component imports for class instants', () => {
  it.each(CLIENT_IMPORTED)('%s reaches no server-only module at runtime', (entry) => {
    expect(forbiddenReached(entry)).toEqual([]);
  });
});

describe('the walk itself', () => {
  it('finds a forbidden module from a module that imports one', () => {
    expect(forbiddenReached('src/lib/timezone.ts')).toContain(
      'src/lib/timezone.ts -> src/lib/log.ts',
    );
  });
});
