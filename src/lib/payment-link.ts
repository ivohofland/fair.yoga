import { PAYMENT_LINK_MAX } from '@/lib/input-bounds';

/**
 * A teacher's open-ended payment link (#785) and a class's video link (#911):
 * the rules a stored link satisfies. Client-safe, so the forms and the server
 * agree.
 */

export type PaymentLinkFailure = 'required' | 'too_long' | 'invalid' | 'not_https' | 'has_userinfo';
export type ParsedPaymentLink = { url: string; host: string };

export const PAYMENT_LINK_MESSAGES = {
  required: 'Enter your payment link.',
  too_long: 'That link is too long.',
  invalid: 'Paste the whole link — it starts with https://',
  not_https: 'Use a secure link — one that starts with https://',
  has_userinfo: 'Enter the link without a name and @ before the address.',
} as const satisfies Record<PaymentLinkFailure, string>;

/**
 * Messages for a video link. The link is optional, so an empty value means "no
 * link" rather than `required`; that message is worded anyway so the record
 * stays total over `PaymentLinkFailure`.
 */
export const VIDEO_LINK_MESSAGES = {
  required: 'Enter the video link.',
  too_long: 'That link is too long.',
  invalid: 'Paste the whole link — it starts with https://',
  not_https: 'Use a secure link — one that starts with https://',
  has_userinfo: 'Enter the link without a name and @ before the address.',
} as const satisfies Record<PaymentLinkFailure, string>;

/**
 * Messages for a studio's booking page link. Optional like the video link, so
 * `required` is worded only to keep the record total over `PaymentLinkFailure`.
 */
export const BOOKING_LINK_MESSAGES = {
  required: 'Enter the booking page link.',
  too_long: 'That link is too long.',
  invalid: 'Paste the whole link — it starts with https://',
  not_https: 'Use a secure link — one that starts with https://',
  has_userinfo: 'Enter the link without a name and @ before the address.',
} as const satisfies Record<PaymentLinkFailure, string>;

/**
 * An `https://` link with no userinfo, at most `max` characters before and
 * after normalisation. The query string and fragment are kept.
 */
export function parseHttpsLink(
  raw: string,
  max: number,
): ({ ok: true } & ParsedPaymentLink) | { ok: false; error: PaymentLinkFailure } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'required' };
  if (trimmed.length > max) return { ok: false, error: 'too_long' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'not_https' };
  // Userinfo puts a host-looking word before the real host; the button's
  // host label exists so the student sees where the link goes.
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'has_userinfo' };
  // The href can outgrow the input once percent-encoded, and the stored value is the href.
  if (url.href.length > max) return { ok: false, error: 'too_long' };
  return { ok: true, url: url.href, host: url.hostname.replace(/^www\./, '') };
}

export function parsePaymentLink(
  raw: string,
): ({ ok: true } & ParsedPaymentLink) | { ok: false; error: PaymentLinkFailure } {
  return parseHttpsLink(raw, PAYMENT_LINK_MAX);
}

/** A stored value re-parsed for display; null when it does not parse. */
export function paymentLinkFromColumn(stored: string | null): ParsedPaymentLink | null {
  if (stored === null) return null;
  const parsed = parsePaymentLink(stored);
  return parsed.ok ? { url: parsed.url, host: parsed.host } : null;
}

/**
 * A stored link as its host and the last four characters of its path, the
 * way `maskedIdentifier` shows a bank account: `revolut.me/…cher`. The query
 * and fragment are left out; a link with no path shows its host alone. A
 * value that does not parse shows none of itself.
 */
export function maskPaymentLink(raw: string): string {
  const parsed = parsePaymentLink(raw);
  if (!parsed.ok) return 'an unreadable link';
  const path = new URL(parsed.url).pathname.replace(/^\/+|\/+$/g, '');
  return path === '' ? parsed.host : `${parsed.host}/…${path.slice(-4)}`;
}
