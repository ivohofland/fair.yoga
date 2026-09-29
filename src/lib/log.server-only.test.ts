/**
 * Pins `import 'server-only';` in log.ts. Removing it would pass every
 * other check — `next build` fails only on a leak that already exists.
 * See log.ts's header for the mechanism.
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
