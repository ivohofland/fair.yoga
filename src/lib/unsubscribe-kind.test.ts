import { describe, it, expect } from 'vitest';
import { isUnsubscribeKind, peekUnsubscribeKind, UNSUBSCRIBE_KINDS } from './unsubscribe-kind';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('unsubscribe kinds', () => {
  it('recognises every registered kind and nothing else', () => {
    for (const kind of Object.keys(UNSUBSCRIBE_KINDS)) expect(isUnsubscribeKind(kind)).toBe(true);
    expect(isUnsubscribeKind('magic_link')).toBe(false);
    expect(isUnsubscribeKind('toString')).toBe(false);
  });

  it('peeks the kind from a token payload without verifying it', () => {
    expect(peekUnsubscribeKind(`${b64('v1.teacher_bookings.abc')}.sig`)).toBe('teacher_bookings');
  });

  it.each([
    '',
    'nodot',
    `${b64('v2.teacher_bookings.abc')}.sig`,
    `${b64('v1.nope.abc')}.sig`,
    '%%%.sig',
  ])('answers null for %j', (token) => {
    expect(peekUnsubscribeKind(token)).toBeNull();
  });
});
