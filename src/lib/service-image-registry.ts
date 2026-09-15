/**
 * Fetches a Docker Hub image tag's current manifest digest — the networked
 * half of the service-image freshness check
 * (`scripts/check-service-image-freshness.ts`). Two-step Docker Hub v2
 * flow: an anonymous auth token scoped to `repository:<repo>:pull`, then a
 * HEAD on the manifest whose `docker-content-digest` response header is the
 * current digest. Every failure mode recognised as "the registry itself is
 * the problem" — a non-OK response, a missing token or digest, or the
 * `fetch()` call itself rejecting — throws `RegistryUnreachableError`; any
 * other failure (e.g. `tokenRes.json()` rejecting because the body isn't
 * JSON) propagates as whatever it natively is. See docs/supply-chain.md
 * ("The database image") for why this fetch logic lives in its own file,
 * separate from `service-image-freshness.ts`.
 */

/** Marks a `fetchLatestDigest` failure as "the registry itself is the problem," not an unexpected one. */
export class RegistryUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RegistryUnreachableError';
  }
}

function toRegistryUnreachableError(err: unknown): RegistryUnreachableError {
  if (err instanceof Error) return new RegistryUnreachableError(err.message, { cause: err.cause });
  return new RegistryUnreachableError(String(err));
}

async function fetchOrThrowUnreachable(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw toRegistryUnreachableError(err);
  }
}

export async function fetchLatestDigest(image: string, tag: string): Promise<string> {
  const repository = image.includes('/') ? image : `library/${image}`;
  const tokenRes = await fetchOrThrowUnreachable(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!tokenRes.ok) throw new RegistryUnreachableError(`auth token request responded ${tokenRes.status}`);
  const tokenData: unknown = await tokenRes.json();
  const token = (tokenData as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token === '') {
    throw new RegistryUnreachableError(`auth response had no "token" field: ${JSON.stringify(tokenData)}`);
  }

  const manifestRes = await fetchOrThrowUnreachable(
    `https://registry-1.docker.io/v2/${repository}/manifests/${tag}`,
    {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json',
      },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!manifestRes.ok) throw new RegistryUnreachableError(`manifest request responded ${manifestRes.status}`);
  const digest = manifestRes.headers.get('docker-content-digest');
  if (!digest) throw new RegistryUnreachableError('manifest response had no docker-content-digest header');
  return digest;
}
