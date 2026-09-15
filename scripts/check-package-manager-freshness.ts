// scripts/check-package-manager-freshness.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkPackageManagerFreshness, parsePackageManagerPin } from '../src/lib/package-manager-freshness';

async function main(): Promise<void> {
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
  const pkg: { packageManager?: string } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

  const pin = parsePackageManagerPin(pkg.packageManager);
  if (!pin) {
    if (pkg.packageManager) {
      // Present but unparseable is a real complaint, not "nothing to check"
      // — a future corepack format change must not silently disable this
      // check. Loud (exitCode 1) even though non-blocking, same as a
      // confirmed-stale pin.
      console.error(
        `Could not parse packageManager pin "${pkg.packageManager}" — expected "<name>@<version>". Review src/lib/package-manager-freshness.ts's PIN_PATTERN against corepack's current field format.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('No packageManager pin found in package.json — nothing to check.');
    return;
  }

  let latest: string;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pin.name}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const data: unknown = await res.json();
    const version = (data as { version?: unknown } | null)?.version;
    if (typeof version !== 'string' || version === '') {
      throw new Error(`registry response had no "version" field: ${JSON.stringify(data)}`);
    }
    latest = version;
  } catch (err) {
    const cause = err instanceof Error && err.cause ? ` — ${String(err.cause)}` : '';
    console.log(
      `Could not reach the registry to check ${pin.name}'s latest version (${err instanceof Error ? err.message : String(err)}${cause}) — skipping.`,
    );
    return;
  }

  const result = checkPackageManagerFreshness(pin.version, latest);

  if (result.fresh) {
    console.log(`✓ ${pin.name}@${pin.version} matches the registry's latest.`);
    return;
  }

  console.error(
    `${pin.name}@${pin.version} is pinned in package.json; the registry's latest is ${latest}. ` +
      `Review whether to bump the packageManager pin (\`corepack use ${pin.name}@${latest}\`). ` +
      'See docs/supply-chain.md for why this check is visible but non-blocking.',
  );
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
