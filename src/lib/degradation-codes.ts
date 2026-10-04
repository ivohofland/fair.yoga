/**
 * Every degradation the app records, each with the severity its log line has
 * and the context keys it may carry. Imports nothing, so a test can read it
 * without pulling in the database.
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
  CLASS_START_UNREADABLE: {
    level: 'warn',
    description:
      'A class date or start time was not a readable Date, so no start instant could be computed. Every caller got an Invalid Date: the class never starts or completes on its own, and its times and deadlines do not render.',
    contextKeys: ['site'],
  },
  PAYMENT_SNAPSHOT_MISSING: {
    level: 'warn',
    description:
      'A completed class had no pricing snapshot (totalRevenue or totalStudents is null) although completion writes both. The student was not shown where their payment went.',
    contextKeys: ['classId', 'registrationId'],
  },
  ENTRY_CONFLICT_KIND_UNKNOWN: {
    level: 'error',
    description:
      'A calendar entry holding the slot a teacher asked for had a kind this code has no name for. The 409 the teacher saw said the time was taken without naming the class, its time or its date.',
    contextKeys: ['teacherId', 'entryId', 'kind'],
  },
  RULE_SLOT_KIND_UNKNOWN: {
    level: 'error',
    description:
      'A recurring rule holding the weekday slot a teacher asked for had a kind this code has no name for. The 409 the teacher saw said the slot was taken without naming which kind of class holds it.',
    contextKeys: ['teacherId', 'kind', 'dayOfWeek'],
  },
  TEACHER_NOTIFICATION_TYPE_UNKNOWN: {
    level: 'error',
    description:
      'A notification addressed to a teacher had a type outside the teacher notification types. It was emailed without consulting the email preferences of the teacher.',
    contextKeys: ['notificationId', 'type'],
  },
  PAYMENT_NOTIFICATION_WITHOUT_CLASS: {
    level: 'warn',
    description:
      'A payment notification for a student had no related class although every writer of one sets it. Its email went out without the Pay now button.',
    contextKeys: ['notificationId', 'type'],
  },
} as const satisfies Record<
  string,
  { level: 'warn' | 'error'; description: string; contextKeys: readonly string[] }
>;

export type DegradationCode = keyof typeof DEGRADATION_CODES;

/** True for a registered code only; `in` would also accept `'toString'`. */
export function isDegradationCode(code: string): code is DegradationCode {
  return Object.hasOwn(DEGRADATION_CODES, code);
}

/** The context a call site may pass for `C`; every key optional. */
export type DegradationContext<C extends DegradationCode> = {
  [K in (typeof DEGRADATION_CODES)[C]['contextKeys'][number]]?: string | number;
};
