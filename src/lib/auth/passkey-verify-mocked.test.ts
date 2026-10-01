import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '@/lib/log';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/types';

// Mocks `@simplewebauthn/server`'s verify calls directly, so each case states
// the library outcome it needs instead of building a response that produces
// it.
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
  vi.mocked(verifyRegistrationResponse).mockReset();
  vi.mocked(verifyAuthenticationResponse).mockReset();
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
      // Only `id` is read, by the helper's check that it matches the mocked
      // `credential.id`; the mocked library call never inspects the rest.
      response: { id: credentialId } as RegistrationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
    });

    if (!result.verified) {
      throw new Error(`expected a verified result, got: ${result.reason}`);
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
    expect(result.reason).toBe('Attestation statement did not verify');
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

  it("logs a caught error's name and first stack frame beside its reason", async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.mocked(verifyRegistrationResponse).mockRejectedValue(new TypeError('boom'));

    await verifyPasskeyRegistration({
      response: { id: 'cred-id' } as RegistrationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
    });

    expect(warnSpy.mock.calls[0]?.[0]).toEqual({
      ceremony: 'registration',
      credentialId: 'cred-id',
      reason: 'boom',
      errorName: 'TypeError',
      frame: expect.stringMatching(/^at \S/),
    });
  });

  it('takes the first frame after the message, so a message cannot forge one', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.mocked(verifyRegistrationResponse).mockRejectedValue(
      new Error('challenge "x\n    at forged (fake.js:1:1)"'),
    );

    await verifyPasskeyRegistration({
      response: {} as RegistrationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
    });

    const fields = warnSpy.mock.calls[0]?.[0] as { frame?: string };
    expect(fields.frame).toMatch(/^at /);
    expect(fields.frame).not.toContain('forged');
  });

  it('caps the logged frame at 200 characters', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const error = new Error('boom');
    error.stack = `Error: boom\n    at ${'f'.repeat(400)} (x.js:1:1)`;
    vi.mocked(verifyRegistrationResponse).mockRejectedValue(error);

    await verifyPasskeyRegistration({
      response: {} as RegistrationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
    });

    const fields = warnSpy.mock.calls[0]?.[0] as { frame?: string };
    expect(fields.frame).toBe(`at ${'f'.repeat(197)}`);
  });

  it('logs no name or frame for a non-Error throw', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.mocked(verifyRegistrationResponse).mockRejectedValue('a plain string throw');

    await verifyPasskeyRegistration({
      response: {} as RegistrationResponseJSON,
      expectedChallenge: 'irrelevant-with-the-library-mocked',
    });

    const fields = warnSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields.errorName).toBeUndefined();
    expect(fields.frame).toBeUndefined();
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
    expect(result.reason).toBe('Signature did not verify against the stored public key');
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
