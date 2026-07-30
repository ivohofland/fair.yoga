import type { PaymentStatus } from '@prisma/client';

/**
 * Runtime validation for `PaymentStatus` values arriving from the network.
 *
 * A module of its own rather than two functions inside
 * `use-payment-actions.ts`: they were exported there *solely* so their unit
 * test could reach them, which this repo otherwise does not do — `isValidTimeZone`
 * (`schemas.ts`) and `timeZoneOffsetMs` (`timezone.ts`) are module-private and
 * tested through their public entry points. Their tests are worth keeping (each
 * one catches a mutation no other test does — see `payment-status.test.ts`), so
 * the fix is to give them a module whose public surface they legitimately are,
 * not to delete them.
 *
 * Imported by a `'use client'` module, so the `@prisma/client` import here is
 * type-only, like every other one in a client path in this repo.
 */

/**
 * Requires *every* member of the enum: adding one to the schema breaks this
 * initializer until it is listed here, which is the point. A
 * `readonly PaymentStatus[]` would accept a subset silently.
 *
 * The values are hand-listed rather than derived from Prisma's runtime enum
 * export (which does exist) because this module is reached from client
 * components and every `@prisma/client` import in a `'use client'` path in this
 * repo is type-only — a value import would be the first, and would risk pulling
 * the Prisma runtime into the browser bundle. The `Record` pin buys the drift
 * protection instead.
 */
const PAYMENT_STATUSES: Record<PaymentStatus, true> = {
  pending: true,
  paid: true,
  overdue: true,
};

/**
 * A `Set`, not `Object.hasOwn`: `tsc` accepts `Object.hasOwn` here only because
 * `lib` includes `esnext`, while `target` is ES2017 and a library method is not
 * downleveled — the lib setting describes a runtime we have not committed to.
 * A Set also has no prototype keys, so 'constructor' cannot sneak through.
 */
const PAYMENT_STATUS_KEYS: ReadonlySet<string> = new Set(Object.keys(PAYMENT_STATUSES));

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === 'string' && PAYMENT_STATUS_KEYS.has(value);
}

/**
 * Reads the status out of the undo endpoint's `{ data: { status } }` envelope.
 *
 * Returns `null` — not a substituted `'pending'` — for anything it cannot read.
 * The caller decides what an unreadable response should mean and applies its own
 * `?? 'pending'`, so that decision is visible at the site that makes it. A
 * signature of `(json: unknown) => PaymentStatus` read as "extracts and
 * validates" while quietly inventing a value, which is exactly the kind of
 * invisible fallback this function exists to replace.
 */
export function readUndoStatus(json: unknown): PaymentStatus | null {
  if (json !== null && typeof json === 'object' && 'data' in json) {
    const data = json.data;
    if (
      data !== null &&
      typeof data === 'object' &&
      'status' in data &&
      isPaymentStatus(data.status)
    ) {
      return data.status;
    }
  }
  return null;
}
