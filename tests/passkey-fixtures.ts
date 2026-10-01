/**
 * WebAuthn responses built without an authenticator, for the passkey
 * helpers' unit tests and the passkey routes' integration tests. Each builder
 * takes the challenge, origin and RP ID the verifier will expect, so the same
 * response can target the unit tier's stubbed environment or the app under
 * test.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { cose, isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/types';

/** The challenge a wrong-challenge `clientDataJSON` names. */
export const WRONG_CHALLENGE = 'not-the-issued-challenge';

/**
 * A base64url `clientDataJSON` carrying only a `type` and `WRONG_CHALLENGE`.
 * The library reads the challenge before the origin, the authenticator data,
 * the attestation object or the signature, so a response carrying this
 * reaches the challenge check unsigned.
 */
export function wrongChallengeClientDataJSON(type: 'webauthn.create' | 'webauthn.get'): string {
  return Buffer.from(JSON.stringify({ type, challenge: WRONG_CHALLENGE })).toString('base64url');
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** An EC P-256 public key as the COSE ES256 key the library stores and verifies against. */
export function coseES256PublicKey(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.x === undefined || jwk.y === undefined) {
    throw new Error('expected an EC public key with x and y');
  }
  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [cose.COSEKEYS.kty, cose.COSEKTY.EC2],
      [cose.COSEKEYS.alg, cose.COSEALG.ES256],
      [cose.COSEKEYS.crv, cose.COSECRV.P256],
      [cose.COSEKEYS.x, isoBase64URL.toBuffer(jwk.x)],
      [cose.COSEKEYS.y, isoBase64URL.toBuffer(jwk.y)],
    ]),
  );
}

/** What a verifier will expect: the issued challenge, its origin and its RP ID. */
export interface ExpectedCeremony {
  challenge: string;
  origin: string;
  rpId: string;
}

function clientDataJSON(type: 'webauthn.create' | 'webauthn.get', expected: ExpectedCeremony): string {
  return isoBase64URL.fromUTF8String(
    JSON.stringify({ type, challenge: expected.challenge, origin: expected.origin, crossOrigin: false }),
  );
}

/**
 * A registration response the real library VERIFIES: a `fmt: 'none'`
 * attestation carries no signature, so anything that knows the issued
 * challenge, the origin and the RP ID can build one. `authDataCredentialId`
 * is the id written into the authenticator data — the one the library
 * returns — independently of `responseId`. The credential key is a fresh
 * P-256 key; nothing verifies a signature with it.
 *
 * `userVerified: false` clears the UV flag and nothing else.
 */
export function forgedNoneRegistration(
  params: ExpectedCeremony & {
    authDataCredentialId: Uint8Array;
    responseId: string;
    userVerified?: boolean;
  },
): RegistrationResponseJSON {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  // UP | AT, plus UV unless `userVerified` is false: user present, attested
  // credential data, user verified.
  const flags = Uint8Array.of(0x01 | 0x40 | (params.userVerified === false ? 0 : 0x04));
  const counter = new Uint8Array(4);
  const aaguid = new Uint8Array(16);
  const credentialIdLength = new Uint8Array(2);
  new DataView(credentialIdLength.buffer).setUint16(0, params.authDataCredentialId.byteLength);
  const authData = new Uint8Array(
    Buffer.concat([
      sha256(params.rpId),
      flags,
      counter,
      aaguid,
      credentialIdLength,
      params.authDataCredentialId,
      coseES256PublicKey(publicKey),
    ]),
  );

  const attestationObject = isoCBOR.encode(
    new Map<string, string | Uint8Array | Map<string, never>>([
      ['fmt', 'none'],
      ['attStmt', new Map<string, never>()],
      ['authData', authData],
    ]),
  );

  return {
    id: params.responseId,
    rawId: params.responseId,
    type: 'public-key',
    response: {
      clientDataJSON: clientDataJSON('webauthn.create', params),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
    },
    clientExtensionResults: {},
  };
}

/**
 * An authentication response signed with `privateKey` over
 * `authenticatorData ‖ sha256(clientDataJSON)`, as an ES256 authenticator
 * signs. Given a `counter` above the stored one, it passes every check before
 * the signature, so whether it verifies is whether `privateKey` pairs with
 * the public key the verifier is given.
 *
 * `userVerified: false` clears the UV flag and nothing else.
 */
export function signedAssertion(
  params: ExpectedCeremony & {
    credentialId: string;
    counter: number;
    privateKey: KeyObject;
    userVerified?: boolean;
  },
): AuthenticationResponseJSON {
  // UP, plus UV unless `userVerified` is false: user present, user verified.
  const flags = Uint8Array.of(0x01 | (params.userVerified === false ? 0 : 0x04));
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, params.counter);
  const authenticatorData = Buffer.concat([sha256(params.rpId), flags, counter]);

  const clientData = clientDataJSON('webauthn.get', params);
  const signature = sign(
    'sha256',
    Buffer.concat([authenticatorData, sha256(isoBase64URL.toBuffer(clientData))]),
    params.privateKey,
  );

  return {
    id: params.credentialId,
    rawId: params.credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: clientData,
      authenticatorData: isoBase64URL.fromBuffer(new Uint8Array(authenticatorData)),
      signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
    },
    clientExtensionResults: {},
  };
}
