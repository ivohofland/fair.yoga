import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '@/lib/log';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/types';

// Mocks `@simplewebauthn/server`'s verify calls directly: the branches these
// cases exercise — the library resolving `verified: false`, throwing
// something other than an `Error`, or resolving `transports` with junk
// members — are not reachable by building a real attestation/assertion
// through this module's public API.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

const { verifyRegistrationResponse, verifyAuthenticationResponse } = await import(
  '@simplewebauthn/server'
);
const { verifyPasskeyRegistration, verifyPasskeyAuthentication } = await import('./passkey');

afterEach(() => {
  vi.restoreAllMocks();
});

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
          // 'constructor' and '__proto__' are inherited property names on
          // any plain object — present here to pin the filter to an
          // own-property check rather than one that walks the prototype
          // chain.
          transports: [
            'usb',
            1,
            'carrier-pigeon',
            'internal',
            'bad\u0000value',
            'constructor',
            '__proto__',
          ],
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

describe('verifyPasskeyRegistration, library mocked', () => {
  it('resolves to a refusal, with one warn, when the library resolves verified: false', async () => {
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: false,
    } as unknown as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const result = await verifyPasskeyRegistration({
      response: {} as RegistrationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
    });

    if (result.verified) {
      throw new Error('expected a refusal');
    }
    expect(result.reason).toBe('Registration response was not verified');
    const refusalWarnings = warnSpy.mock.calls.filter(
      (call) => (call[0] as { ceremony?: string }).ceremony === 'registration',
    );
    expect(refusalWarnings).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('truncates a caught message longer than 300 characters', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.mocked(verifyRegistrationResponse).mockRejectedValue(new Error('x'.repeat(400)));

    const result = await verifyPasskeyRegistration({
      response: {} as RegistrationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
    });

    if (result.verified) {
      throw new Error('expected a refusal');
    }
    expect(result.reason).toBe('x'.repeat(300));
  });

  it('formats a non-Error throw with String()', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.mocked(verifyRegistrationResponse).mockRejectedValue('a plain string throw');

    const result = await verifyPasskeyRegistration({
      response: {} as RegistrationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
    });

    if (result.verified) {
      throw new Error('expected a refusal');
    }
    expect(result.reason).toBe(String('a plain string throw'));
  });
});

describe('verifyPasskeyAuthentication, library mocked', () => {
  it('resolves to a refusal, with one warn, when the library resolves verified: false', async () => {
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: false,
      authenticationInfo: {
        credentialID: 'irrelevant',
        newCounter: 0,
        userVerified: false,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://localhost:3000',
        rpID: 'localhost',
      },
    } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const result = await verifyPasskeyAuthentication({
      response: {} as AuthenticationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
      credentialPublicKey: new Uint8Array(),
      credentialCounter: 0,
    });

    if (result.verified) {
      throw new Error('expected a refusal');
    }
    expect(result.reason).toBe('Authentication response was not verified');
    const refusalWarnings = warnSpy.mock.calls.filter(
      (call) => (call[0] as { ceremony?: string }).ceremony === 'authentication',
    );
    expect(refusalWarnings).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('truncates a caught message longer than 300 characters', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.mocked(verifyAuthenticationResponse).mockRejectedValue(new Error('y'.repeat(400)));

    const result = await verifyPasskeyAuthentication({
      response: {} as AuthenticationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
      credentialPublicKey: new Uint8Array(),
      credentialCounter: 0,
    });

    if (result.verified) {
      throw new Error('expected a refusal');
    }
    expect(result.reason).toBe('y'.repeat(300));
  });

  it('formats a non-Error throw with String()', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.mocked(verifyAuthenticationResponse).mockRejectedValue(42);

    const result = await verifyPasskeyAuthentication({
      response: {} as AuthenticationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
      credentialPublicKey: new Uint8Array(),
      credentialCounter: 0,
    });

    if (result.verified) {
      throw new Error('expected a refusal');
    }
    expect(result.reason).toBe(String(42));
  });
});
