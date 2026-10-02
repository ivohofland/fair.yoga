import { describe, it, expect } from 'vitest';
import { isPushServiceEndpoint } from './endpoint';

describe('isPushServiceEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGx1',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://fcm.googleapis.com:443/fcm/send/explicit-default-port',
  ])('accepts %s', (url) => {
    expect(isPushServiceEndpoint(url)).toBe(true);
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['an arbitrary host', 'https://evil.example/push'],
    ['a lookalike host ending in a push suffix plus more', 'https://evilpush.apple.com.attacker.example/x'],
    ['a host that merely ends in the suffix text', 'https://evilpush.apple.com/x'],
    ['the bare suffix', 'https://push.apple.com/x'],
    ['a subdomain of an exact-match host', 'https://x.fcm.googleapis.com/fcm/send/abc'],
    ['a userinfo trick', 'https://fcm.googleapis.com@evil.example/'],
    ['userinfo before a real push host', 'https://user:pass@fcm.googleapis.com/fcm/send/abc'],
    ['a non-default port', 'https://fcm.googleapis.com:8443/fcm/send/abc'],
    ['an IP literal', 'https://127.0.0.1/push'],
    ['not a URL', 'not-a-url'],
  ])('rejects %s', (_label, url) => {
    expect(isPushServiceEndpoint(url)).toBe(false);
  });
});
