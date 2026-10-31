import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(__dirname, '../..');

describe('public/embed/v1.js', () => {
  it('is exactly what the build produces from the current source', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'fy-embed-'));
    try {
      execFileSync(process.execPath, [path.join(repo, 'scripts/build-embed.mjs'), out], { cwd: repo, stdio: 'pipe' });
      const fresh = readFileSync(path.join(out, 'v1.js'), 'utf8');
      const committed = readFileSync(path.join(repo, 'public/embed/v1.js'), 'utf8');
      expect(committed, 'public/embed/v1.js is stale: run `pnpm run build:embed`').toBe(fresh);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
