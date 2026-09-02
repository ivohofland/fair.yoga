import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { generatePasskeyAuthenticationOptions, storeChallenge } from '@/lib/auth';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';

const WINDOW_MS = 60 * 60 * 1000;
const PER_IP_LIMIT = 100;

/**
 * Mints a WebAuthn authentication challenge, IP-rate-limited to 100/hour.
 *
 * Reads nothing from the request but the caller's IP — not even an email.
 * #187: this route used to look the posted address up and return its
 * credential ids in `allowCredentials`, which told an unauthenticated caller
 * whether the address had an account, whether it had a passkey, how many, and
 * what their ids were. Equalising the response shape alone would not have been
 * enough: the lookup itself is a timing signal, one query for an unknown
 * address against two for a known one. Removing the input removes both, and
 * leaves an invariant that can be checked by reading the signature — no
 * request-controlled value reaches the response.
 *
 * The cost is that the ceremony now needs a discoverable credential. See
 * docs/technical-architecture.md ("Passkey authentication options").
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  // The IP is the only thing read from the request, and it never reaches the
  // response. With the oracle closed there is nothing left to enumerate, so
  // this budget exists to bound challenge-store churn: without it a flood can
  // still evict other callers' in-flight challenges before they're redeemed.
  const ip = clientIp(request);
  const check = checkIpRateLimit(
    'passkey-auth-options',
    ip,
    PER_IP_LIMIT,
    WINDOW_MS,
    'passkey/authenticate/options',
  );
  if (!check.allowed) return respondRateLimited(check, 'Too many sign-in attempts.');

  const options = await generatePasskeyAuthenticationOptions();

  // Random key so the verify endpoint can retrieve it; the challenge id is the
  // only handle the client gets.
  const challengeId = crypto.randomBytes(16).toString('hex');
  storeChallenge('authentication', challengeId, options.challenge);

  return respondOk({ options, challengeId });
});
