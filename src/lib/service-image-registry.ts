/**
 * Fetches a Docker Hub image tag's current manifest digest — the networked
 * half of the service-image freshness check
 * (`scripts/check-service-image-freshness.ts`). Two-step Docker Hub v2
 * flow: an anonymous auth token scoped to `repository:<repo>:pull`, then a
 * HEAD on the manifest whose `docker-content-digest` response header is the
 * current digest. See docs/supply-chain.md ("The database image") for why
 * this fetch logic lives in its own file, separate from the pure
 * parsing/comparison functions in `service-image-freshness.ts`.
 */

export async function fetchLatestDigest(image: string, tag: string): Promise<string> {
  const repository = image.includes('/') ? image : `library/${image}`;
  const tokenRes = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!tokenRes.ok) throw new Error(`auth token request responded ${tokenRes.status}`);
  const tokenData: unknown = await tokenRes.json();
  const token = (tokenData as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token === '') {
    throw new Error(`auth response had no "token" field: ${JSON.stringify(tokenData)}`);
  }

  const manifestRes = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!manifestRes.ok) throw new Error(`manifest request responded ${manifestRes.status}`);
  const digest = manifestRes.headers.get('docker-content-digest');
  if (!digest) throw new Error('manifest response had no docker-content-digest header');
  return digest;
}
