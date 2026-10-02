import { describe, it, expect } from 'vitest';
import { encryptPayload } from './encrypt';

// RFC 8291 §5 and Appendix A, verbatim (whitespace removed).
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('encryptPayload (RFC 8291 aes128gcm)', () => {
  it('reproduces the RFC 8291 example byte for byte', () => {
    const out = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.authSecret },
      { serverPrivateKey: Buffer.from(RFC.asPrivate, 'base64url'), salt: Buffer.from(RFC.salt, 'base64url') },
    );
    expect(out.toString('base64url')).toBe(RFC.body);
  });

  it('uses a fresh salt and server key per message when not seeded', () => {
    const keys = { p256dh: RFC.uaPublic, auth: RFC.authSecret };
    const a = encryptPayload(Buffer.from('x'), keys);
    const b = encryptPayload(Buffer.from('x'), keys);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
  });

  it('refuses a malformed browser key', () => {
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: RFC.authSecret })).toThrow();
  });
});
