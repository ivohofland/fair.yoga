/**
 * What each `RegistrationStatus` means for seat occupancy, and the subset the
 * app derives from it.
 *
 * One definition, in `lib/` and import-free at runtime, for the same reason
 * `class-fields.ts` and `tiers.ts` are: a `'use client'` component that ever
 * needs this list must be able to import it without dragging `@/lib/log`
 * (pino, server-only) into the browser bundle. The `import type` below erases
 * completely, so this module emits no runtime import at all.
 *
 * `cancelled` and `late_cancel` are absent from `ACTIVE_REGISTRATION_STATUSES`
 * deliberately — both freed the seat. `late_cancel` still bills (it is in
 * `CHARGED_STATUSES`, `services/class-lifecycle.ts`), which is why the two sets
 * exist and differ by exactly that one member.
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

/**
 * Every status, and whether it occupies or frees a seat in the class.
 *
 * `Record` over the enum is EXHAUSTIVE — adding a sixth member to the schema
 * is a compile error here until it is classified, which is the mechanical fix
 * #132 established following #218.
 *
 * The values are hand-listed rather than derived from Prisma's runtime enum
 * export because this module is reached from client components and every
 * `@prisma/client` import in a `'use client'` path in this repo is type-only —
 * a value import would pull the Prisma runtime into the browser bundle.
 */
const REGISTRATION_ROLE: Record<RegistrationStatus, 'occupies' | 'frees'> = {
  registered: 'occupies',
  attended: 'occupies',
  no_show: 'occupies',
  late_cancel: 'frees',
  cancelled: 'frees',
};

/**
 * A `Set`, not `Object.hasOwn` or `in`: `tsc` accepts `Object.hasOwn` only
 * because `lib` includes `esnext`, while `target` is ES2017. A Set also has no
 * prototype keys, so 'constructor' and 'toString' cannot sneak through.
 */
const REGISTRATION_STATUS_KEYS: ReadonlySet<string> = new Set(Object.keys(REGISTRATION_ROLE));

export function isRegistrationStatus(value: unknown): value is RegistrationStatus {
  return typeof value === 'string' && REGISTRATION_STATUS_KEYS.has(value);
}

/**
 * The registration statuses that occupy a seat.
 *
 * Derived from `REGISTRATION_ROLE` so it cannot drift from the exhaustive
 * classification above.
 */
export const ACTIVE_REGISTRATION_STATUSES: readonly RegistrationStatus[] = Object.freeze(
  (Object.keys(REGISTRATION_ROLE) as RegistrationStatus[]).filter(
    (status) => REGISTRATION_ROLE[status] === 'occupies',
  ),
);

