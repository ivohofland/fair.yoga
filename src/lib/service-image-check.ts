/**
 * Runs the per-`image:tag` freshness check for
 * `scripts/check-service-image-freshness.ts`'s main loop: fetches each
 * group's latest digest (injected, so tests can substitute a mock without
 * touching the network) and reports every pin's freshness against it,
 * skipping — not crashing — a group whose fetch rejects with a
 * `RegistryUnreachableError`. Any other rejection propagates rather than
 * being folded into that skip path. Extracted so the loop has a home
 * under `src/lib` that vitest's `unit` project collects, letting #608's
 * acceptance criteria (one fetch per group; a rejected fetch skips rather
 * than throws) be asserted directly.
 */
import { checkServiceImageFreshness, type ImagePin } from './service-image-freshness';
import { RegistryUnreachableError } from './service-image-registry';

export interface CheckGroupsResult {
  readonly anyStale: boolean;
  readonly skippedGroups: number;
}

export async function checkGroups<T extends ImagePin & { readonly file: string }>(
  byImageTag: ReadonlyMap<string, readonly T[]>,
  fetchDigest: (image: string, tag: string) => Promise<string>,
): Promise<CheckGroupsResult> {
  let anyStale = false;
  let skippedGroups = 0;
  for (const [key, group] of byImageTag) {
    const { image, tag } = group[0]!;
    let latest: string;
    try {
      latest = await fetchDigest(image, tag);
    } catch (err) {
      if (!(err instanceof RegistryUnreachableError)) throw err;
      const cause = err.cause ? ` — ${String(err.cause)}` : '';
      skippedGroups++;
      console.log(
        `::warning::Could not reach the registry to check ${key}'s latest digest (${err.message}${cause}) — skipping.`,
      );
      continue;
    }

    for (const pin of group) {
      const result = checkServiceImageFreshness(pin.digest, latest);
      if (result.fresh) {
        console.log(`✓ ${pin.file}: ${key}@${pin.digest} matches the registry's latest.`);
      } else {
        anyStale = true;
        console.error(
          `${pin.file}: ${key} is pinned at ${result.pinned}; the registry's latest is ${result.latest}. ` +
            `Review whether to bump the digest (see docs/supply-chain.md, "The database image").`,
        );
      }
    }
  }

  return { anyStale, skippedGroups };
}
