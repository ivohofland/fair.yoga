/**
 * The supply-chain settings are present, and they are in the ONE file pnpm
 * reads them from.
 *
 * WHY THIS EXISTS WHEN CI IS ALREADY GREEN. Three of the four controls in
 * `pnpm-workspace.yaml` are gated by CI as a side effect of what CI does:
 * `strictDepBuilds` + `allowBuilds` by every frozen install, the release-age
 * policy by the lockfile check those installs perform, and `packageManager`'s
 * integrity hash by the corepack bootstrap in `.github/actions/setup-pnpm`.
 * `verifyDepsBeforeRun` is not, and structurally cannot be: it only ever fires
 * on a `pnpm run`/`pnpm exec` whose `node_modules` disagrees with
 * `package.json`, and every job installs before its first one — which is
 * exactly what makes the setting cost CI nothing. Delete the line and CI stays
 * fully green.
 *
 * WHY PLACEMENT IS ASSERTED AND NOT ONLY PRESENCE. pnpm reads these settings
 * from `pnpm-workspace.yaml` and nowhere else. In `.npmrc` (kebab-case or
 * camelCase) or under `package.json`'s `pnpm` key they are ignored with no
 * diagnostic at all — the install still succeeds, so nothing downstream
 * notices. The realistic path there is a contributor who hits
 * `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`, moves the settings into a new `.npmrc`
 * because that is where npm settings live, sees `pnpm test` work again, and
 * has silently disabled the whole policy with CI green. So the absence of the
 * two wrong homes is asserted alongside the contents of the right one.
 *
 * `packageManager` is here for the same reason from the other side: it decides
 * WHICH pnpm reads this file, and a pnpm that does not know these settings
 * runs a `--frozen-lockfile` install that verifies nothing and exits 0. The
 * runner-side half of that check lives in `.github/actions/setup-pnpm`; this
 * half covers laptops, where there is no runner to check anything.
 *
 * The measurements behind every claim above are in `docs/supply-chain.md`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

/**
 * Top-level scalars only, which is the whole of what is asserted here: the
 * pattern is anchored at column 0, so comments, blank lines and the indented
 * members of a block mapping are all skipped. A key introducing a block
 * (`allowBuilds:`) reads back as `null` — present, with its contents left to
 * the install itself, which is the only thing that can say whether the list is
 * right.
 */
function topLevelSettings(text: string): Record<string, string | null> {
  const settings: Record<string, string | null> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (match === null) continue;
    const value = (match[2] ?? '').trim();
    settings[match[1] ?? ''] = value === '' ? null : value;
  }
  return settings;
}

describe('the pnpm supply-chain policy is present, and in the file pnpm reads', () => {
  it('holds every setting in pnpm-workspace.yaml, and nowhere else', () => {
    const settings = topLevelSettings(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    const packageManager = manifest.packageManager;

    // One comparison over the whole shape rather than an assertion apiece, so
    // a failure reports which part broke instead of stopping at the first.
    expect({
      minimumReleaseAge: settings.minimumReleaseAge,
      verifyDepsBeforeRun: settings.verifyDepsBeforeRun,
      strictDepBuilds: settings.strictDepBuilds,
      allowBuildsPresent: 'allowBuilds' in settings,
      npmrcAtRepoRoot: existsSync(path.join(root, '.npmrc')),
      pnpmKeyInPackageJson: 'pnpm' in manifest,
      packageManagerPinsPnpm: typeof packageManager === 'string' && packageManager.startsWith('pnpm@'),
      packageManagerCarriesIntegrityHash:
        typeof packageManager === 'string' && packageManager.includes('+sha512.'),
    }).toEqual({
      minimumReleaseAge: '10080',
      verifyDepsBeforeRun: 'error',
      strictDepBuilds: 'true',
      allowBuildsPresent: true,
      npmrcAtRepoRoot: false,
      pnpmKeyInPackageJson: false,
      packageManagerPinsPnpm: true,
      packageManagerCarriesIntegrityHash: true,
    });
  });
});
