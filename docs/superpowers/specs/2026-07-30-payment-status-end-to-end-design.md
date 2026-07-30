# PaymentStatus end to end

**Date:** 2026-07-30
**Status:** Approved (issue #58; design agreed with Ivo in discussion — concrete
`PaymentStatus` rather than a type parameter, a validated response instead of a
cast, and the two other widening points fixed in the same sitting)

## Problem

PR #57 tightened the payment status prop to `PaymentStatus` at two component
boundaries. `usePaymentActions` (`src/lib/use-payment-actions.ts:14`) stores and
returns `Record<string, string>`, so the tightening is re-widened the moment a
value flows through the hook. Every value that actually gates the UI is `string`:

| Site | Expression | Type today |
|---|---|---|
| `payment-checklist.tsx:58` | `paymentState[item.paymentId] ?? 'pending'` | `string` |
| `outstanding-payment-row.tsx:55` | `paymentState[paymentId] ?? status` | `string` |
| `student-payment-list.tsx:32` | `paymentState[item.paymentId] ?? 'pending'` | `string` |

A typo like `'overdu'`, or a renamed enum member, is not caught by `tsc` at any
of them. The exhaustiveness that motivated the `string → PaymentStatus` change
is not realised downstream.

**The issue undercounts the widening.** It lists `student-payment-list.tsx` as a
file to "verify it still type-checks". In fact its own `StudentPaymentItem.status`
is declared `string` (`:11`) while `students/[id]/page.tsx:152` hands it
`reg.payment!.status`, a real `PaymentStatus` — a third untightened boundary that
#57 missed rather than a consumer to check. And `paymentStateText`
(`format.ts:27`) takes `status: string`, making it a fourth.

## Design

### 1. Concrete `PaymentStatus`, not a type parameter

The issue proposes `usePaymentActions<S extends string>`. Rejected. All three
consumers carry payment status; there is no second status union in the app, so
the parameter is generality with no second instance to justify it.

It also makes the network problem worse rather than better. Under `S`, the undo
response has to be read as `{ data: { status: S } }` — an assertion that the
server returned a member of a union **the caller chose**, which is unverifiable
by construction. Under a concrete `PaymentStatus`, the same value is checkable
against a known set, which is what §2 does.

```ts
import type { PaymentStatus } from '@prisma/client';

export function usePaymentActions(initial: Record<string, PaymentStatus>) {
  const [paymentState, setPaymentState] =
    useState<Record<string, PaymentStatus>>(initial);
```

`markPaid`'s `'paid'` (`:30`) satisfies this as a literal and needs no change.

Note that `noUncheckedIndexedAccess` is on, so `paymentState[id]` is
`PaymentStatus | undefined` and the existing `?? 'pending'` / `?? status`
fallbacks are load-bearing, not decorative. They keep working unchanged and
their results become `PaymentStatus`.

### 2. The undo response: validated, not asserted

`undo` currently reads

```ts
const json = (await res.json()) as { data: { status: string } };   // :51
```

An unchecked assertion over a network payload — the least trustworthy value in
the file, and precisely the "type assertion to silence an error" the project
forbids. It becomes a real guard:

```ts
/**
 * Requires every member: adding one to the schema breaks this line until it is
 * listed, which is the point. A `readonly PaymentStatus[]` would accept a
 * subset silently.
 */
const PAYMENT_STATUSES: Record<PaymentStatus, true> = {
  pending: true,
  paid: true,
  overdue: true,
};
const PAYMENT_STATUS_KEYS: ReadonlySet<string> = new Set(Object.keys(PAYMENT_STATUSES));

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === 'string' && PAYMENT_STATUS_KEYS.has(value);
}
```

Four properties, each deliberate:

- **No assertion anywhere.** A type predicate is the sanctioned narrowing
  mechanism, not a way around one.
- **No value import of `@prisma/client`.** Prisma does export the enum at
  runtime (`{ pending: 'pending', … }` — verified), and deriving the list from
  it would be drift-proof. But every Prisma import in a `'use client'` file in
  this repo is `import type`, erased at compile time; a value import would be
  the first, and risks pulling the Prisma runtime into the browser bundle. The
  `Record<PaymentStatus, true>` pin buys the same drift protection at compile
  time instead.
- **`Set.has`, not `Object.hasOwn`.** `tsc` accepts `Object.hasOwn` here because
  `lib` includes `esnext` — but `target` is `ES2017` and a library method is not
  downleveled, so the `lib` setting is describing a runtime we have not
  committed to. `Set` is ES2015. It also sidesteps the prototype-chain question
  that makes `in` wrong for this.
- **The fallback stays `'pending'`.** `unmarkPaymentPaid` writes
  `status: 'pending'` unconditionally (`services/payments.ts:97`), so a
  well-behaved server always sends a value the guard accepts; the fallback is
  for the case where it does not.

The read becomes `const json: unknown = await res.json()`, a narrowing of the
nested shape, then `isPaymentStatus(...) ? ... : 'pending'`.

**Why not drop the round trip entirely.** Considered: `markPaid` sets `'paid'`
locally without reading the response, and since the server always writes
`'pending'`, `undo` could set `'pending'` and delete the whole problem. Rejected
because the two are not symmetric. `markPaid`'s result is what the action
*means*; undo's result is a service decision. `unmarkPaymentPaid` writes
`'pending'` unconditionally today — the daily dunning sweep re-derives
`'overdue'` later, from the payment's age — so `'overdue'` is not a
currently-reachable response from this endpoint. The round trip is a guard
against a *future* change to that service, not a currently-reachable case: it
is what keeps the UI correct the day `unmarkPaymentPaid` starts returning a
re-derived status itself, and the guard is what makes reading it honest in the
meantime.

### 3. The other two widening points

**`StudentPaymentItem.status`** (`student-payment-list.tsx:11`) becomes
`PaymentStatus`. Its page already passes one; only the declaration widens it.
This is not optional once §1 lands — the hook's `initial` parameter no longer
accepts `Record<string, string>`, so the file would not compile.

**`paymentStateText`** (`format.ts:27`) takes `PaymentStatus` and gains an
exhaustiveness guard:

```ts
export function paymentStateText(status: PaymentStatus): { label: string; className: string } {
  if (status === 'paid') return { label: '✓ Paid', className: 'text-teal' };
  if (status === 'overdue') return { label: '! Overdue', className: 'text-danger font-medium' };
  if (status === 'pending') return { label: '○ Unpaid', className: '' };
  const unhandled: never = status;
  throw new Error(`Unhandled payment status: ${String(unhandled)}`);
}
```

Today's trailing `return { label: '○ Unpaid' }` is a catch-all: a new
`refunded` member would render as "Unpaid" and nothing would complain. Naming
`'pending'` explicitly and closing with `never` turns that into a build failure,
matching the idiom #100 established across the template services.

Its third caller — `bookings/page.tsx:209`, on the student side, which the issue
does not mention — includes the full Prisma `payment` (`:36`), so it already
passes a real `PaymentStatus` and needs no change. Worth verifying, not worth
touching.

## Testing

No runtime behaviour changes for any value the app actually produces, so most of
this is verified by `tsc`. Two things are genuinely new executable code and get
real tests; one existing gap gets closed because this change lands on top of it.

- **`isPaymentStatus` — unit** (`src/lib/use-payment-actions.test.ts`, picked up
  by the `unit` project's `src/**/*.test.ts`; node environment, which is fine
  because the guard is a pure function and nothing renders the hook there).
  Each of the three members; then `'overdu'`, `''`, `'PENDING'`, `null`,
  `undefined`, `42`, and `'constructor'` — the last because it is what
  distinguishes `Set.has` from an `in` check against a plain object, which is
  the mistake this shape exists to avoid.
- **`paymentStateText` — unit** (`src/lib/format.test.ts`). It has **no tests
  today**, verified. It gets one per member, asserting label and className,
  since this change rewrites its branch structure and its catch-all is becoming
  a guard.
- **The `never` guard is verified by mutation, not by a runtime test.** Add a
  fourth member to the schema enum, confirm `tsc` fails at `paymentStateText`
  and at `PAYMENT_STATUSES`, remove it. A passing `tsc` on unchanged code
  demonstrates nothing about a guard — per the #66 lesson, confirm the mutation
  landed before trusting the result, and do not migrate the schema for this.
- **The undo round trip — component** (`outstanding-payment-row.test.tsx`). The
  `vi.stubGlobal('fetch', …)` scaffolding is already in that file from #59.
  **Two** assertions, and the order of importance is the opposite of the
  obvious one:
  1. Resolve undo with `status: 'overdue'` and assert the row renders its
     `· ! overdue` marker. This is the one that matters — it proves the server's
     value is *used*. It is also the only one that fails if someone replaces the
     round trip with a hardcoded `'pending'`, which is the simplification §2
     explicitly rejected.
  2. Resolve undo with a bad status and assert no overdue marker. This pins the
     fallback.

  Assertion 2 alone would be near-worthless: a hardcoded `'pending'` passes it.
  Recorded because that is the version this spec first described.

Not added: component tests for `payment-checklist.tsx` or
`student-payment-list.tsx`. Neither has one today, and this change gives neither
new runtime behaviour to pin — adding them would be worth doing on its own
terms, not smuggled in here.

## Out of scope

- **The `?? 'pending'` fallbacks.** Existing behaviour; whether an unknown
  payment should read as unpaid is a product question, not a types one.
- **`MarkUnpaidButton`'s accessible name** — #128.
- **The class page's mark-paid label** — #129.
- **Consolidating `format.ts`'s date formatters** — #96. This touches
  `paymentStateText`, which is not a date formatter and not part of that
  decision.
- **Making the hook reusable for a non-payment status union.** No such union
  exists; §1 is the argument.

## Risks

- **`format.ts` is shared by three surfaces, one of them student-facing.** The
  signature change is compile-checked at all three, so the risk is not a missed
  call site but a *behaviour* change smuggled in with the refactor. The labels
  and classNames must come out byte-identical; the new unit tests are what hold
  that.
- **The `never` guard throws where the old code returned.** For any status the
  schema can produce this branch is unreachable, so the throw is a
  can't-happen assertion rather than a new failure mode. Worth stating because
  a reviewer seeing a `throw` added to a formatter should be able to check that
  reasoning rather than reconstruct it.
- **The mutation test edits `prisma/schema.prisma`.** It must be reverted, and
  no migration may be created for it — the repo rule is that schema changes go
  through `npx prisma migrate dev`, and this is deliberately not a schema change.
