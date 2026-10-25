/**
 * The economic fields that become immutable once settings_locked flips true
 * (i.e., after the first student registers).
 *
 * Lives in `lib/` rather than beside `updateClass` because
 * `class-edit-form.tsx` needs the *value* at runtime to strip these keys from
 * a locked payload, and it is a `'use client'` component: importing from
 * `services/class-lifecycle.ts` would fail `next build`, since that module
 * transitively imports `@/lib/log` (pino, server-only). This module has no
 * imports at all, which is what makes it safe from either side — the same
 * property that lets the client-side pricing preview import `services/pricing.ts`.
 */
export const ECONOMIC_FIELDS = Object.freeze([
  'roomCost',
  'minRate',
  'targetRate',
  'minStudents',
  'maxStudents',
  'vatPercent',
] as const);

export type EconomicField = (typeof ECONOMIC_FIELDS)[number];

/**
 * The schedule fields that become immutable at the same moment (#836). A
 * class's free-cancel deadline and auto-cancel check are both measured from
 * its start, so moving a booked class would move every student's deadline
 * under them.
 */
export const SCHEDULE_LOCKED_FIELDS = Object.freeze(['date', 'startTime'] as const);

export type ScheduleLockedField = (typeof SCHEDULE_LOCKED_FIELDS)[number];

/**
 * How a class is priced (#912). Locked with the economics: a booked class's
 * students booked against the pricing it showed them.
 */
export const PRICING_LOCKED_FIELDS = Object.freeze(['pricingMode'] as const);

export type PricingLockedField = (typeof PRICING_LOCKED_FIELDS)[number];

/** Everything `settingsLocked` freezes: the economics, the pricing mode, then the schedule. */
export const LOCKED_FIELDS = Object.freeze([
  ...ECONOMIC_FIELDS,
  ...PRICING_LOCKED_FIELDS,
  ...SCHEDULE_LOCKED_FIELDS,
] as const);

export type LockedField = (typeof LOCKED_FIELDS)[number];
