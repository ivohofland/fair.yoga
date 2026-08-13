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
 * The annotation pins MEMBERSHIP, not completeness: every entry must be a real
 * `RegistrationStatus`, so a renamed enum member fails `tsc`. It does NOT
 * assert the list is exhaustive, and must not be "fixed" into something that
 * does — this list is a subset by design. (#39 shipped the opposite mistake: a
 * `satisfies` read as a completeness pin when it only ever pinned membership.)
 *
 * **If you are here because you are ADDING a `RegistrationStatus`, nothing will
 * stop you forgetting this file.** Verified during #218's review: there is no
 * `Record<RegistrationStatus, …>`, no indexed type and no exhaustive `switch`
 * anywhere in `src/`, so a new member compiles clean and is silently absent
 * from both subsets — it would occupy no seat (here) and bill nothing
 * (`CHARGED_STATUSES`, `services/class-lifecycle.ts`). Deliberately a comment
 * and not a tracker entry: the failure needs to be read at the moment someone
 * edits the enum, which is this docblock and that one, and an issue nobody
 * opens is worse than a note everybody hits. The mechanical fix, if it ever
 * earns its keep, is one `Record<RegistrationStatus, 'occupies' | 'frees'>`
 * that both lists derive from — `Record` over an enum is exhaustive, so a new
 * member becomes a compile error exactly where the decision belongs.
 *
 * **Annotated and frozen, NOT `as const satisfies`** — the same shape as
 * `CHARGED_STATUSES`, and the difference is not cosmetic. `as const` infers the
 * literal tuple `readonly ["registered","attended","no_show"]`, which narrows
 * `Array.prototype.includes`' parameter to those three literals — so every
 * membership test had to widen it back with `as readonly string[]`, and that
 * cast accepts *any* string. Under it,
 * `ACTIVE_REGISTRATION_STATUSES.includes(entry.status)` on a `WaitlistStatus`
 * compiled clean and silently always returned false. The annotation keeps
 * `.includes` typed as `RegistrationStatus`, so the three call sites need no
 * cast and a wrong-enum argument is a compile error. Pinning membership at the
 * definition is worth nothing if it disables checking at every use.
 *
 * `Object.freeze` for the same reason `CHARGED_STATUSES` has it: this list
 * gates every capacity decision on the platform, and one stray `push` through
 * a widened alias would change what "full" means everywhere at once.
 *
 * Prisma's `in:` filter wants a mutable `RegistrationStatus[]` and will not
 * take a readonly one, so filter call sites spread —
 * `in: [...ACTIVE_REGISTRATION_STATUSES]` — exactly as `CHARGED_STATUSES`'
 * callers do. That is a constraint on the call site, not on the source of
 * truth, and it is unaffected by the annotation change above.
 */
import type { RegistrationStatus } from '@prisma/client';

export const ACTIVE_REGISTRATION_STATUSES: readonly RegistrationStatus[] = Object.freeze([
  'registered',
  'attended',
  'no_show',
]);
