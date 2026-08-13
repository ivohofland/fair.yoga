/**
 * The registration statuses that occupy a seat.
 *
 * One definition, in `lib/` and import-free at runtime, for the same reason
 * `class-fields.ts` and `tiers.ts` are: a `'use client'` component that ever
 * needs this list must be able to import it without dragging `@/lib/log`
 * (pino, server-only) into the browser bundle. The `import type` below erases
 * completely, so this module emits no runtime import at all.
 *
 * `cancelled` and `late_cancel` are absent deliberately — both freed the seat.
 * `late_cancel` still bills (it is in `CHARGED_STATUSES`,
 * `services/class-lifecycle.ts`), which is why the two sets exist and differ
 * by exactly that one member.
 *
 * The `satisfies` pins MEMBERSHIP, not completeness: every entry must be a
 * real `RegistrationStatus`, so a renamed enum member fails `tsc`. It does
 * NOT assert the list is exhaustive, and must not be "fixed" into something
 * that does — this list is a subset by design. (#39 shipped the opposite
 * mistake: a `satisfies` read as a completeness pin when it only ever pinned
 * membership.)
 *
 * Prisma's `in:` filter wants a mutable `RegistrationStatus[]` and will not
 * take a readonly one, so callers spread — `in: [...ACTIVE_REGISTRATION_STATUSES]`
 * — exactly as `CHARGED_STATUSES`' callers do. That is a constraint on the
 * call site, not on the source of truth.
 */
import type { RegistrationStatus } from '@prisma/client';

export const ACTIVE_REGISTRATION_STATUSES = ['registered', 'attended', 'no_show'] as const satisfies readonly RegistrationStatus[];
