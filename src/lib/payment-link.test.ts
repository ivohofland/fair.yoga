import { describe, it, expect } from 'vitest';
import { parsePaymentLink, paymentLinkFromColumn, maskPaymentLink, PAYMENT_LINK_MESSAGES } from './payment-link';
import { PAYMENT_LINK_MAX } from './input-bounds';

describe('parsePaymentLink', () => {
  it('accepts an https link and shows its host without www', () => {
    expect(parsePaymentLink('https://www.paypal.me/annayoga')).toEqual({
      ok: true, url: 'https://www.paypal.me/annayoga', host: 'paypal.me',
    });
  });
  it('trims surrounding whitespace and a trailing newline', () => {
    expect(parsePaymentLink('  https://revolut.me/anna\n')).toEqual({
      ok: true, url: 'https://revolut.me/anna', host: 'revolut.me',
    });
  });
  it('accepts an upper-case scheme and stores it normalised', () => {
    const r = parsePaymentLink('HTTPS://Tikkie.me/pay/abc');
    expect(r).toEqual({ ok: true, url: 'https://tikkie.me/pay/abc', host: 'tikkie.me' });
  });
  it.each([
    ['http://revolut.me/anna', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['data:text/html,hi', 'not_https'],
    ['paypal.me/anna', 'invalid'],
    ['https://revolut.me@evil.example/', 'has_userinfo'],
    ['https://user:pw@revolut.me/', 'has_userinfo'],
    ['   ', 'required'],
    ['', 'required'],
  ] as const)('refuses %s as %s', (raw, error) => {
    expect(parsePaymentLink(raw)).toEqual({ ok: false, error });
  });
  it('refuses a link over the bound', () => {
    const raw = `https://example.com/${'a'.repeat(PAYMENT_LINK_MAX)}`;
    expect(parsePaymentLink(raw)).toEqual({ ok: false, error: 'too_long' });
  });
  it('refuses a link that is within the bound as typed but over it once percent-encoded', () => {
    const raw = `https://x.example/${'é'.repeat(200)}`;
    expect(raw.length).toBeLessThanOrEqual(PAYMENT_LINK_MAX);
    expect(parsePaymentLink(raw)).toEqual({ ok: false, error: 'too_long' });
  });
  it('drops only one leading www', () => {
    expect(parsePaymentLink('https://www.www.example.com/')).toMatchObject({ host: 'www.example.com' });
  });
});

describe('paymentLinkFromColumn', () => {
  it('re-parses a stored link', () => {
    expect(paymentLinkFromColumn('https://monzo.me/sarah')).toEqual({ url: 'https://monzo.me/sarah', host: 'monzo.me' });
  });
  it('answers null for no link and for a value that does not parse', () => {
    expect(paymentLinkFromColumn(null)).toBeNull();
    expect(paymentLinkFromColumn('http://monzo.me/sarah')).toBeNull();
  });
});

describe('PAYMENT_LINK_MESSAGES', () => {
  it('names the scheme for the two failures a teacher fixes by adding it', () => {
    expect(PAYMENT_LINK_MESSAGES.invalid).toContain('https://');
    expect(PAYMENT_LINK_MESSAGES.not_https).toContain('https://');
  });
});

describe('maskPaymentLink', () => {
  it('shows the host and the last four characters of the path', () => {
    expect(maskPaymentLink('https://revolut.me/teacher')).toBe('revolut.me/…cher');
  });
  it('drops a leading www and a trailing slash before taking the tail', () => {
    expect(maskPaymentLink('https://www.paypal.me/annayoga/')).toBe('paypal.me/…yoga');
  });
  it('takes the tail of a nested path, never the whole of it', () => {
    const masked = maskPaymentLink('https://tikkie.me/pay/Yoga/abcdef1234');
    expect(masked).toBe('tikkie.me/…1234');
    expect(masked).not.toContain('abcdef');
  });
  it('ignores the query and fragment', () => {
    expect(maskPaymentLink('https://monzo.me/sarahjones?amount=10#x')).toBe('monzo.me/…ones');
  });
  it('shows the host alone when the link has no path', () => {
    expect(maskPaymentLink('https://pay.example.com/')).toBe('pay.example.com');
  });
  it('reads an unparseable value as an unreadable link, echoing none of it', () => {
    expect(maskPaymentLink('http://revolut.me/teacher')).toBe('an unreadable link');
    expect(maskPaymentLink('not a link at all')).toBe('an unreadable link');
  });
});
