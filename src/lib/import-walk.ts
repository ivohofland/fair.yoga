import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A walk over this repo's own import graph, for tests that pin a boundary
 * between modules (`loading-coverage.test.ts`, `client-server-boundary.test.ts`).
 * Reads source text; it neither imports nor bundles anything. Named without a
 * `.test.` suffix so no vitest project collects it as an empty test file.
 */

export const SRC = path.resolve(__dirname, '..');

/** `'use client'` as a module's first statement, after comments. */
export const CLIENT_DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/;

/** A module that refuses to be bundled for the browser. */
export const SERVER_ONLY_IMPORT = /^import\s+['"]server-only['"]/m;

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
    ? path.resolve(path.dirname(from), specifier)
    : null;
  if (base === null) return null;
  const candidates = [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c) && !statSync(c).isDirectory()) ?? null;
}

// Every value import and re-export (`import type` / `export type` is erased,
// so it is skipped), with its specifier.
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

/**
 * Every module `start` reaches through value imports, breadth-first, that
 * `isTarget` accepts — each reported as its import chain from `start`, paths
 * relative to `src/`. A target is reported and not walked past. Only this
 * repo's own specifiers (`@/…`, `./…`) are followed; one that resolves to no
 * file is reported as `(unresolved)` rather than skipped, so a renamed module
 * cannot hide a chain.
 */
export function chainsTo(start: string, isTarget: (source: string) => boolean): string[] {
  const found: string[] = [];
  const visited = new Set<string>([start]);
  const queue: string[][] = [[start]];
  for (let chain = queue.shift(); chain !== undefined; chain = queue.shift()) {
    const file = chain[chain.length - 1] ?? start;
    for (const [, typeOnly, specifier] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      if (typeOnly !== undefined || specifier === undefined) continue;
      if (!specifier.startsWith('@/') && !specifier.startsWith('.')) continue;
      const show = (tail: string) => [...chain.map((f) => path.relative(SRC, f)), tail].join(' → ');
      const target = resolveImport(file, specifier);
      if (target === null) {
        found.push(show(`${specifier} (unresolved)`));
        continue;
      }
      if (visited.has(target)) continue;
      visited.add(target);
      if (isTarget(readFileSync(target, 'utf8'))) found.push(show(path.relative(SRC, target)));
      else queue.push([...chain, target]);
    }
  }
  return found;
}
