import { z } from 'zod';

/**
 * The input limits decided in
 * `docs/superpowers/specs/2026-10-07-input-bounds-design.md` (§2.1), and the
 * zod builders that apply the text ones. Client-safe: it imports nothing but
 * `zod`, so a client component can import it.
 */

// ---------------------------------------------------------------------------
// Text limits, in UTF-16 code units: what `.max()` and an input's
// `maxLength` both count.
// ---------------------------------------------------------------------------

export const NAME_MAX = 60;
export const CLASS_TYPE_MAX = 80;
export const LOCATION_MAX = 200;
export const VENUE_NAME_MAX = 120;
export const ROOM_NAME_MAX = 80;
export const ROOM_ADDRESS_MAX = 200;
export const CITY_MAX = 100;
export const POSTCODE_MAX = 16;
export const FLOOR_MAX = 40;
export const EQUIPMENT_ITEM_MAX = 60;
export const EQUIPMENT_ITEMS_MAX = 30;
export const LONG_TEXT_MAX = 2000;
export const PAYMENT_METHOD_MAX = 64;
/** RFC 5321's limit on a forward path. */
export const EMAIL_MAX = 254;
export const PAGE_SLUG_MAX = 60;

// ---------------------------------------------------------------------------
// Number limits.
// ---------------------------------------------------------------------------

export const DURATION_MAX_MINUTES = 1440;
export const MONEY_MAX = 100000;
export const CAPACITY_MAX = 1000;

// ---------------------------------------------------------------------------
// Character rules.
// ---------------------------------------------------------------------------

/**
 * Control characters, format characters other than ZWNJ (U+200C) and ZWJ
 * (U+200D), and the line and paragraph separators. ZWNJ and ZWJ stay legal
 * because Indic and Persian scripts and emoji sequences need them; every
 * other `\p{Cf}` is a bidi control, a byte-order mark or an invisible
 * splitter that can make `evil\u200B.com` render as `evil.com`.
 */
const SINGLE_LINE_REFUSED = /\p{Cc}|(?![\u200C\u200D])\p{Cf}|[\p{Zl}\p{Zp}]/u;

/** `SINGLE_LINE_REFUSED`, less the newline, carriage return and tab. */
const MULTI_LINE_REFUSED = /(?![\n\r\t])\p{Cc}|(?![\u200C\u200D])\p{Cf}|[\p{Zl}\p{Zp}]/u;

/**
 * Generic TLDs the host-shaped test refuses after a dot, beside two ASCII
 * letters in one case (which covers every country code). Deliberately short: a
 * complete list drifts, and a member that is also a common name particle
 * (`van`, `del`, `den`) would refuse real abbreviated names.
 */
export const COMMON_GENERIC_TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'edu', 'gov', 'app', 'dev', 'xyz',
  'online', 'site', 'shop', 'store', 'top', 'club', 'live', 'link', 'click',
  'email', 'tech', 'cloud', 'page', 'pro', 'website', 'space',
] as const;

/** A scheme separator, a `www.` prefix or an `@`. */
const LINK_MARKER = /:\/\/|www\.|@/iu;

/** Dots that render like `.` in a host name: U+3002, U+FF0E, U+FF61, U+2024. */
const LOOKALIKE_DOT = /[\u3002\uFF0E\uFF61\u2024]/u;

/**
 * A host-shaped token: a label of two or more letters, digits or hyphens, a
 * `.`, then a suffix not followed by a letter. The two-character label keeps
 * `J.de Groot` and `J.R.` legal; the exact-length suffix keeps `St.Clair`,
 * `Th.van Dijk` and `Ma.del Carmen` legal.
 *
 * A two-letter suffix counts only in one case, `nl` or `NL`, so a
 * capitalised given name after a title (`Mr.Li Wei`, `Dr.Oz`) stays legal.
 * A `COMMON_GENERIC_TLDS` member counts in any case.
 */
const HOST_LABEL = '[\\p{L}\\p{N}-]{2,}\\.';
// A combining mark continues the letter before it, so `An.le` + U+0301 reads
// the same as precomposed `An.lé`.
const SUFFIX_END = '(?![\\p{L}\\p{M}])';
const HOST_COUNTRY_CODE = new RegExp(`${HOST_LABEL}(?:[a-z]{2}|[A-Z]{2})${SUFFIX_END}`, 'u');
const HOST_GENERIC = new RegExp(`${HOST_LABEL}(?:${COMMON_GENERIC_TLDS.join('|')})${SUFFIX_END}`, 'iu');

/** ZWNJ and ZWJ: legal in a name, invisible in a rendered host. */
const JOINERS = /[\u200C\u200D]/gu;

/**
 * Reads the value as it renders: with the joiners `singleLineText` lets
 * through removed, `evil\u200D.com` is the `evil.com` a reader sees.
 */
function looksLikeLink(value: string): boolean {
  const rendered = value.replace(JOINERS, '');
  return (
    LINK_MARKER.test(rendered) ||
    LOOKALIKE_DOT.test(rendered) ||
    HOST_COUNTRY_CODE.test(rendered) ||
    HOST_GENERIC.test(rendered)
  );
}

const CONTROL_MESSAGE = 'Remove the hidden or control characters.';
const LINK_MESSAGE = "This can't contain a web or email address.";

function tooLongMessage(max: number): string {
  return `Keep this to ${max} characters or fewer.`;
}

// ---------------------------------------------------------------------------
// Builders. Each returns a zod string the caller chains `.min(1)`,
// `.optional()` or `.default('')` onto.
// ---------------------------------------------------------------------------

/**
 * One line of text: trimmed, then checked, then capped at `max`. The trim
 * runs first so a pasted name's stray edge newline or tab is stripped, as it
 * always was, rather than refused. `trim()` removes only whitespace, so an
 * invisible splitter or a control character at an edge is still refused.
 */
export function singleLineText(max: number) {
  return z
    .string()
    .trim()
    .refine((v) => !SINGLE_LINE_REFUSED.test(v), CONTROL_MESSAGE)
    .max(max, tooLongMessage(max));
}

/**
 * Free text that may span lines. Not trimmed: the value is stored exactly as
 * sent, so an edit form that resends it unchanged writes the same bytes.
 */
export function multiLineText(max: number) {
  return z
    .string()
    .refine((v) => !MULTI_LINE_REFUSED.test(v), CONTROL_MESSAGE)
    .max(max, tooLongMessage(max));
}

/**
 * `singleLineText` that also refuses link-shaped text, for the strings that
 * reach an address which never signed up: a person's name and a class type.
 */
export function linkFreeText(max: number) {
  return singleLineText(max).refine((v) => !looksLikeLink(v), LINK_MESSAGE);
}
