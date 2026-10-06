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
] as const);

export type EconomicField = (typeof ECONOMIC_FIELDS)[number];
