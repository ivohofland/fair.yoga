import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLIENT_DIRECTIVE, SERVER_ONLY_IMPORT, SRC, chainsTo } from './import-walk';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const clientModules = sourceFiles(SRC).filter((file) => CLIENT_DIRECTIVE.test(readFileSync(file, 'utf8')));

// `import 'server-only'` fails the browser bundle, but only when a route is
// built: `next build` in CI, or the page itself in `next dev`. Unit and
// component tests run in Node, where the import is harmless, so a client
// component reaching it passes every one of them. This walks the same edge
// from the source, and names the chain the build error leaves out.
describe('client modules and server-only code', () => {
  it('finds the client modules it checks', () => {
    // Guards the walk below against passing vacuously on a broken directive match.
    expect(clientModules.length).toBeGreaterThan(0);
  });

  it('no \'use client\' module reaches a server-only module through its imports, however indirectly', () => {
    const offending = clientModules.flatMap((file) => chainsTo(file, (source) => SERVER_ONLY_IMPORT.test(source)));
    expect(offending).toEqual([]);
  });
});
