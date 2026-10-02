/**
 * Every degradation the app records, each with the severity its log line has
 * and the context keys it may carry. Imports nothing, so a test or a doc
 * generator can read it without pulling in the database.
 *
 * A code names one intentional fallback: a place that substitutes or withholds
 * a value because data that should have been impossible turned up. Which sites
 * qualify, and why the rest do not, is `docs/degradation-sites.md`.
 *
 * `contextKeys` is the allowlist `logDegraded` enforces at runtime as well as
 * in the types. Every key holds an id, an enum, a number or an IANA zone
 * string; a key that could hold something a person typed does not belong here.
 */
export const DEGRADATION_CODES = {
  INCOME_TIER_OUT_OF_RANGE: {
    level: 'warn',
    description:
      'A stored income tier was outside 1–5 although a CHECK constraint forbids it. The median tier was substituted, or the claim about this person was withheld.',
    contextKeys: ['tier', 'studentId', 'registrationId'],
  },
  TIMEZONE_INVALID_FALLBACK_UTC: {
    level: 'error',
    description:
      'A stored timezone would not resolve. A calendar day, a time label or a wall-clock instant was computed in UTC instead.',
    contextKeys: ['timeZone', 'site'],
  },
} as const satisfies Record<
  string,
  { level: 'warn' | 'error'; description: string; contextKeys: readonly string[] }
>;

export type DegradationCode = keyof typeof DEGRADATION_CODES;

/** The context a call site may pass for `C`; every key optional. */
export type DegradationContext<C extends DegradationCode> = {
  [K in (typeof DEGRADATION_CODES)[C]['contextKeys'][number]]?: string | number;
};
