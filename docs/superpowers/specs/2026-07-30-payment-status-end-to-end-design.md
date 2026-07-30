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

*Line numbers in this section are as of the branch point (`main` at `32e27f3`),
which is the state being described. They have moved in the shipped files — the
type imports and comments this change adds push each of the three down a few
lines. The Design and Testing sections below describe what ships.*

**The issue undercounts the widening.** It lists `student-payment-list.tsx` as a
file to "verify it still type-checks". In fact its own `StudentPaymentItem.status`
is declared `string` (`:11`) while `students/[id]/page.tsx:152` hands it
`reg.payment!.status`, a real `PaymentStatus` — a third untightened boundary that
#57 missed rather than a consumer to check. And `paymentStateText`
(`format.ts:27`) takes `status: string`, making it a fourth.

**There is a fifth.** `class-list.tsx`'s `ClassWithDetails.registrations`
(`:13`) declares `{ payment: { status: string } | null }[]`, and its `.filter`
narrowing (`:74`) repeats the same `string`, while real `PaymentStatus` data
flows in from both `(teacher)/page.tsx:54` and
`schedule/past/page.tsx:20`. Unlike the other four, this one was not caught
during design at all — it surfaced only in the final whole-branch review
before the PR, which is why it is described here rather than counted above
with the rest.

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
fallbacks are load-bearing, not decorative. Their results become
`PaymentStatus`.

**They did not all keep working unchanged, as this originally said.** Review
found the three surfaces disagreeing about what an unknown row means:
`outstanding-payment-row.tsx:55` reads `?? status`, the row's own
server-rendered value, while `payment-checklist.tsx` and
`student-payment-list.tsx` fabricated `'pending'` with `item.status` sitting
unused in the same scope. The two now match the one. That is reachable, not
theoretical — `usePaymentActions` seeds from `items` through `useState`, which
ignores every later argument, and a `router.refresh()` re-renders these
components without remounting, so a payment appearing after mount has no entry
in `paymentState` and an overdue one rendered as the calm "○ Unpaid". See
"Out of scope" below, where this was originally parked.

### 2. The undo response: validated, not asserted

`undo` currently reads

```ts
const json = (await res.json()) as { data: { status: string } };   // :51
```

An unchecked assertion over a network payload — the least trustworthy value in
the file, and precisely the "type assertion to silence an error" the project
forbids. It becomes a real guard, which review moved into a module of its own
(`src/lib/payment-status.ts`) so that its tests reach a genuine public surface
rather than exports the hook module carried only for them:

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
- **The fallback stays `'pending'`, but not inside the reader.**
  `unmarkPaymentPaid` writes `status: 'pending'` unconditionally
  (`services/payments.ts:97`), so a well-behaved server always sends a value the
  guard accepts; the fallback is for the case where it does not. Review moved
  *where* it is applied: `readUndoStatus` returns `PaymentStatus | null` and
  `undo` writes `?? 'pending'`. A signature of `(json: unknown) => PaymentStatus`
  read as "extracts and validates" while quietly substituting a value, and the
  substitution was invisible at the call site — which is also where it now gets
  logged.

The read becomes `const json: unknown = await res.json()`, a narrowing of the
nested shape, then `isPaymentStatus(...) ? ... : null` with the caller's
`?? 'pending'`.

**And that read must not sit in the fetch's `try`** — a review finding, and the
one real bug on this branch rather than a types question. It did, so an `ok`
response with an unreadable body (a proxy error page, a truncation on flaky
wifi) was reported as `'Network error. Try again.'` and `undo` returned `false`,
*after* the server had already committed `'pending'`. The row kept `isPaid`,
kept "✓ Paid" and its Undo button, and — because `isOutstanding` derives from
the same stale value — hid the reminder button for a debt that now really
existed; a second Undo got the service's contradictory
`Cannot undo: current status is "pending"`. `send-reminder-button.tsx:71-86`
already handles the identical "server committed, body unreadable" case and
states the principle: past the point of commitment, an unreadable body is
logged, not dressed up as a failure. `undo` follows it — logs, resolves local
state to `'pending'`, clears `justMarked`, leaves the error banner empty, and
returns `true` so the caller's `router.refresh()` reconciles.

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
  console.error('[payment-state-text] unhandled payment status', { status: String(unhandled) });
  return { label: '○ Unpaid', className: '' };
}
```

Today's trailing `return { label: '○ Unpaid' }` is an *unguarded* catch-all: a
new `refunded` member would render as "Unpaid" and nothing would complain.
Naming `'pending'` explicitly and closing with `never` turns that into a build
failure, matching the idiom #100 established across the template services.

**The last branch still returns, and that is deliberate** — corrected in review,
where the first version of this threw. The `never` is the whole value of the
branch and stays; the throw was not. `bookings/page.tsx` is an async server
component with `export const dynamic = 'force-dynamic'` that calls this during
render, and the app's only error boundary (`app/error.tsx`, plus
`global-error.tsx`) logs nothing — so on enum or deploy drift a throw takes down
an entire student-facing page on every request with no diagnostic trail, which
is strictly worse than the catch-all it replaced (one mislabelled row). It logs
instead, and falls back to `'○ Unpaid'`: one of the three labels the design
system has, and the one that never overclaims payment. `console.error`, not
`lib/log.ts`, because that module is pino and server-only while `format.ts` is
imported by `'use client'` components.

Its third caller — `bookings/page.tsx:209`, on the student side, which the issue
does not mention — includes the full Prisma `payment` (`:36`), so it already
passes a real `PaymentStatus` and needs no change. Worth verifying, not worth
touching.

## Testing

Most of this is verified by `tsc`: for the type work proper, no runtime
behaviour changes for any value the app actually produces. That framing held
for the spec as designed and no longer describes the whole branch — review
turned up one real runtime bug (`undo`'s error handling, §2) and two real
mislabelling paths (the fallbacks, §1), and each of those is pinned by a test
that fails against the code as it was.

- **`isPaymentStatus` — unit** (`src/lib/payment-status.test.ts`, picked up
  by the `unit` project's `src/**/*.test.ts`; node environment, which is fine
  because the guard is a pure function and nothing renders the hook there).
  Each of the three members; then `'overdu'`, `''`, `'PENDING'`, `null`,
  `undefined`, `42`, and `'constructor'` — the last because it is what
  distinguishes `Set.has` from an `in` check against a plain object, which is
  the mistake this shape exists to avoid. Originally
  `src/lib/use-payment-actions.test.ts`, importing two functions the hook
  exported only for it; the file moved with the functions.
- **`paymentStateText` — unit** (`src/lib/format.test.ts`). It has **no tests
  today**, verified. It gets one per member, asserting label and className,
  since this change rewrites its branch structure and its catch-all is becoming
  a guard. Its last branch gets none: it is unreachable for every value the type
  admits, and reaching it from a test would take the type assertion this project
  forbids.
- **The `never` guard is verified by mutation, not by a runtime test.** Add a
  fourth member to the schema enum, confirm `tsc` fails at `paymentStateText`
  and at `PAYMENT_STATUSES` (now in `payment-status.ts`), remove it. A passing
  `tsc` on unchanged code demonstrates nothing about a guard — per the #66
  lesson, confirm the mutation landed before trusting the result, and do not
  migrate the schema for this.
- **The undo round trip — component** (`outstanding-payment-row.test.tsx`). The
  `vi.stubGlobal('fetch', …)` scaffolding is already in that file from #59.
  **Three** assertions — two as designed, the third added in review — and the
  order of importance is the opposite of the obvious one:
  1. Resolve undo with `status: 'overdue'` and assert the row renders its
     `· ! overdue` marker. This is the one that matters — it proves the server's
     value is *used*. It is also the only one that fails if someone replaces the
     round trip with a hardcoded `'pending'`, which is the simplification §2
     explicitly rejected.
  2. Resolve undo with a bad status and assert no overdue marker, and that the
     shape case was logged. This pins the fallback and where it is applied.
  3. Resolve undo `ok` with a body that throws on `.json()`: the row leaves the
     paid state, **no** error banner appears, `router.refresh()` runs, and the
     body case is logged. This is the one that fails against the pre-review
     `undo`.

  Assertion 2 alone would be near-worthless: a hardcoded `'pending'` passes it.
  Recorded because that is the version this spec first described.
- **The two fallbacks — component**
  (`payment-checklist.test.tsx`, `student-payment-list.test.tsx`, both new).
  Each re-renders its component with a payment that appears after mount and
  asserts the row shows that payment's own status rather than a fabricated
  `'pending'`. One per file: reverting either line alone leaves the other's test
  green. **This reverses what this section said** — "Not added: component tests
  for `payment-checklist.tsx` or `student-payment-list.tsx` … this change gives
  neither new runtime behaviour to pin". True as designed; false once review
  changed a line of behaviour in each.
- **`PaymentRollup` — component** (`class-list.test.tsx`, new; §"There is a
  fifth"). It had no coverage anywhere — unit, component and e2e all grepped,
  zero hits — and the type change gives it none: what it carries is a priority
  order (overdue > unpaid > all-paid) and a `payments.length === 0` guard,
  neither of which a type protects. Six tests, rendered through `ClassList`
  rather than by exporting the rollup, each mutation-verified. The guard's
  mutation is the one to keep in view: without it a completed class whose
  registrations have no payment rows reports "✓ all paid", the false all-clear
  this branch is named for.

## Out of scope

- ~~**The `?? 'pending'` fallbacks.** Existing behaviour; whether an unknown
  payment should read as unpaid is a product question, not a types one.~~
  **Brought back in scope in review**, with the repo owner's approval. It turned
  out not to be a product question: `item.status` — the server's own value — was
  in scope at both sites and simply unused, and the third surface already read
  it. See §1.
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
- **The `never` guard's runtime behaviour.** For any status the schema can
  produce this branch is unreachable, so whatever it does is a can't-happen
  path — but "can't happen" is exactly the assumption enum or deploy drift
  breaks, so what it does then is the risk worth naming. It logs
  (`console.error`, since `format.ts` is reachable from client components) and
  returns `'○ Unpaid'`. It does **not** throw: this is called during render by
  an async `force-dynamic` server component on a student-facing page, behind an
  error boundary that logs nothing, so a throw would trade one mislabelled row
  for a dead page on every request with nothing in the logs. The compile-time
  half — a new enum member failing the build here — is unaffected and is the
  reason the branch exists.
- **The mutation test edits `prisma/schema.prisma`.** It must be reverted, and
  no migration may be created for it — the repo rule is that schema changes go
  through `npx prisma migrate dev`, and this is deliberately not a schema change.
