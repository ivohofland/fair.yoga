/**
 * Pins the one way this repo has found to make the `server-only` build guard
 * on `src/lib/log.ts` vanish silently: deleting or commenting out its
 * `import 'server-only';`. See that file's header for the mechanism and the
 * runner aliases. `next build` only catches a leak that already exists —
 * nothing in this tree currently value-imports the logger from client code —
 * so this guards the guard itself, not a leak that is live today.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LOG_PATH = path.join(process.cwd(), 'src/lib/log.ts');

describe('the server-only guard on src/lib/log.ts', () => {
  it('log.ts must import server-only: it is what makes next build reject a client import of the logger', () => {
    const source = readFileSync(LOG_PATH, 'utf8');
    // `preProcessFile` reads import syntax, not text — a comment or string
    // mentioning `server-only` does not satisfy this.
    const { importedFiles } = ts.preProcessFile(source, true, true);
    expect(importedFiles.some((imported) => imported.fileName === 'server-only')).toBe(true);
  });
});
