/**
 * Builds `public/embed/v1.js` from `src/embed/schedule-widget.ts` with the
 * repo's own `tsc` and nothing else (docs/supply-chain.md, The website
 * widget). The compiled module gets one appended line that defines the
 * element against the origin the script was loaded from.
 *   pnpm run build:embed            writes public/embed/v1.js
 *   node scripts/build-embed.mjs D  writes D/v1.js (src/embed/build.test.ts)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(repo, 'public/embed'));
const BOOTSTRAP = 'defineScheduleElement({ origin: new URL(import.meta.url).origin });\n';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const work = mkdtempSync(path.join(tmpdir(), 'fy-embed-tsc-'));
try {
  execFileSync(process.execPath, [tsc, '-p', path.join(repo, 'tsconfig.embed.json'), '--outDir', work], {
    cwd: repo,
    stdio: 'inherit',
  });
  const compiled = readFileSync(path.join(work, 'schedule-widget.js'), 'utf8');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'v1.js'), compiled + BOOTSTRAP);
} finally {
  rmSync(work, { recursive: true, force: true });
}
