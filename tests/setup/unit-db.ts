/**
 * Global setup for the vitest `unit` AND `unit-sweeps` projects: provision
 * and migrate the dedicated test database (docs/test-database.md), and —
 * in a linked worktree — reap any other worktree's orphaned databases and
 * dev-server process (docs/superpowers/specs/2026-09-08-worktree-db-isolation-design.md).
 *
 * `unit-sweeps` is the tier holding the service tests that inject far-future
 * clocks into database-wide sweeps — on a shared database those once
 * completed the seed's future classes and mailed their payment requests.
 * This setup PROVISIONS `DATABASE_URL_TEST` (creates it, migrates it) so
 * those tests have somewhere isolated to run.
 *
 * IT DOES NOT GUARANTEE THEY RUN THERE. The switch is made by
 * `vitest.config.ts`, which resolves both projects' `DATABASE_URL` to
 * `DATABASE_URL_TEST ?? devUrl`. When `DATABASE_URL_TEST` is unset this
 * function returns early and that fallback is the DEV database — the
 * isolation is a value in `.env`, i.e. configuration, not a guard. Suites
 * taking an unscoped destructive write correct this in their own headers;
 * stated here too, because this is the source they copy from.
 *
 * A suite that takes an UNSCOPED destructive write must therefore carry its own
 * runtime guard on the connected database's name, as
 * `waitlist-retention.test.ts` does. CI sets `DATABASE_URL_TEST` explicitly
 * (`.github/workflows/ci.yml`, the `test-unit` job) precisely so that guard does not skip the suite
 * on the merge gate; the early return below is what made it do exactly that.
 */

import { loadEnv } from 'vite';
import { provisionDatabase } from '../../src/lib/db-provision';
import { getWorktreeIdentity } from '../../src/lib/worktree/identity';
import { getRegistryPath } from '../../src/lib/worktree/registry';
import { runReap } from '../../src/lib/worktree/reap';

export default async function setup(): Promise<void> {
  const fileEnv = loadEnv('', process.cwd(), '');
  const devUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  const testUrl = process.env.DATABASE_URL_TEST ?? fileEnv.DATABASE_URL_TEST;

  if (!testUrl) {
    console.log('[unit-db] DATABASE_URL_TEST not set — using DATABASE_URL as-is');
    return;
  }
  if (testUrl === devUrl) {
    throw new Error(
      '[unit-db] DATABASE_URL_TEST equals DATABASE_URL — refusing to run unit tests ' +
        'against the dev database. Point DATABASE_URL_TEST at a separate database.',
    );
  }

  const identity = getWorktreeIdentity();
  if (!identity.isMainCheckout) {
    const reaped = await runReap(identity.gitCommonDir, getRegistryPath(identity.gitCommonDir), testUrl);
    if (reaped.length > 0) {
      console.log(`[unit-db] reaped orphaned worktree resources: ${reaped.join(', ')}`);
    }
  }

  await provisionDatabase(testUrl, { seed: false });
  console.log(`[unit-db] unit tests run against ${new URL(testUrl).pathname.slice(1)}`);
}
