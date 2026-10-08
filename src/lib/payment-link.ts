import { PAYMENT_LINK_MAX } from '@/lib/input-bounds';

/**
 * A teacher's open-ended payment link (#785): the rules a stored link
 * satisfies. Client-safe, so the settings form and the server agree.
 */

export type PaymentLinkFailure = 'required' | 'too_long' | 'invalid' | 'not_https' | 'has_userinfo';
export type ParsedPaymentLink = { url: string; host: string };

export const PAYMENT_LINK_MESSAGES = {
  required: 'Enter your payment link.',
  too_long: 'That link is too long.',
  invalid: 'Enter the full link, starting with https://',
  not_https: 'Enter the full link, starting with https://',
  has_userinfo: 'Enter the link without a name and @ before the address.',
} as const satisfies Record<PaymentLinkFailure, string>;

export function parsePaymentLink(
  raw: string,
): ({ ok: true } & ParsedPaymentLink) | { ok: false; error: PaymentLinkFailure } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'required' };
  if (trimmed.length > PAYMENT_LINK_MAX) return { ok: false, error: 'too_long' };
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
  if (url.href.length > PAYMENT_LINK_MAX) return { ok: false, error: 'too_long' };
  return { ok: true, url: url.href, host: url.hostname.replace(/^www\./, '') };
}

/** A stored value re-parsed for display; null when it does not parse. */
export function paymentLinkFromColumn(stored: string | null): ParsedPaymentLink | null {
  if (stored === null) return null;
  const parsed = parsePaymentLink(stored);
  return parsed.ok ? { url: parsed.url, host: parsed.host } : null;
}
