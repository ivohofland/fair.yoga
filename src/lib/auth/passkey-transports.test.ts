import { describe, it, expect, vi } from 'vitest';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';

// `@simplewebauthn/server`'s own types declare `credential.transports` as
// `AuthenticatorTransportFuture[]`, but that credential crosses an
// attacker-controlled boundary: a `fmt: 'none'` attestation verifies with no
// signature, so a signed-in caller can make the library resolve with
// `transports` holding whatever the client sent. Mocking the library's
// resolution (rather than building a real attestation) is what lets this
// test put junk in that array without the type system refusing it first.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(),
  };
});

const { verifyRegistrationResponse } = await import('@simplewebauthn/server');
const { verifyPasskeyRegistration } = await import('./passkey');

describe('verifyPasskeyRegistration transports filter', () => {
  it('keeps only known AuthenticatorTransportFuture members, in order', async () => {
    const credentialId = Buffer.from('cred-id').toString('base64url');

    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: {
          id: credentialId,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['usb', 1, 'carrier-pigeon', 'internal', 'bad\u0000value'],
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://localhost:3000',
      },
      // The mocked `credential.transports` above deliberately violates the
      // library's own declared type (junk members) to exercise the filter,
      // so the whole resolved value is asserted through `unknown` rather
      // than typechecked against it.
    } as unknown as Awaited<ReturnType<typeof verifyRegistrationResponse>>);

    const result = await verifyPasskeyRegistration({
      // Not read: the mocked library call above never inspects it.
      response: {} as RegistrationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
    });

    if (!result.verified) {
      throw new Error('expected a verified result');
    }
    expect(result.transports).toEqual(['usb', 'internal']);
  });
});
