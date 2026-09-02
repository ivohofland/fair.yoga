import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { generatePasskeyAuthenticationOptions, storeChallenge } from '@/lib/auth';
import { respondOk, withErrorHandler } from '@/lib/api-utils';

/**
 * Mints a WebAuthn authentication challenge.
 *
 * Reads nothing from the request — not even an email. #187: this route used to
 * look the posted address up and return its credential ids in
 * `allowCredentials`, which told an unauthenticated caller whether the address
 * had an account, whether it had a passkey, how many, and what their ids were.
 * Equalising the response shape alone would not have been enough: the lookup
 * itself is a timing signal, one query for an unknown address against two for a
 * known one. Removing the input removes both, and leaves an invariant that can
 * be checked by reading the signature — no request-controlled value reaches the
 * response.
 *
 * The cost is that the ceremony now needs a discoverable credential. See
 * docs/technical-architecture.md ("Passkey authentication options").
 */
export const POST = withErrorHandler(async (_request: NextRequest) => {
  const options = await generatePasskeyAuthenticationOptions();

  // Random key so the verify endpoint can retrieve it; the challenge id is the
  // only handle the client gets.
  const challengeId = crypto.randomBytes(16).toString('hex');
  storeChallenge('authentication', challengeId, options.challenge);

  return respondOk({ options, challengeId });
});
