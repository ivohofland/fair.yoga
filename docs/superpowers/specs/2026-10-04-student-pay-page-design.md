# Student pay page

An outstanding past class gets its own page, `/bookings/[classId]/pay`, where
the student chooses how to pay and gets that method's details. The inline
"How to pay" panel on `/bookings` goes away; the row's **Pay now** pill links
to the page instead. Payment notifications link there too.

The page is the foundation Level 2 (#386) extends: it is where iDEAL and card
rows will start a processor checkout, and where that checkout's redirect will
land. Nothing processor-specific is built here.

## Why a page, not the inline panel

- **Level 2 needs a landing page anyway.** A hosted checkout (Mollie, Stripe)
  redirects back to a URL that has to show the recorded outcome from the
  server. A disclosure inside a list row cannot be that URL.
- **Payment notifications link nowhere today.** `studentNotificationHref`
  links a class only while it is `open` and live; a `payment_request` is about
  a `completed` class, so its inbox row is not clickable. A per-class page
  gives it a target.
- **IA.** Detail views are separate pages with a back link
  (`docs/information-architecture.md`). Inline, the flow nests three levels
  deep inside a list row, and two open overdue rows make `/bookings` very long.

## Premise, verified against the running code

- **`Payment` rows exist only for completed classes.** `completeClass` is the
  only creator (CLAUDE.md, Payment Model), and a cancelled class never has one
  (`CalendarEntry_not_cancelled_and_completed`, `docs/lock-order.md`).
  `Payment.registrationId` is unique, so a registration has at most one.
- **A blank IBAN is storable.** `bankIban` is validated as
  `z.string().nullable().optional()` (`src/lib/schemas.ts`), so `''` can reach
  the row. "Has an IBAN" must mean non-blank, not non-null.
- **The student layout already guards the route.** `(student)/layout.tsx`
  sends a session without a student profile to `/schedule` (teacher) or to
  `/login?redirect=…` (signed out), reading the path from `x-pathname`, which
  `src/proxy.ts` sets on every request — nested paths included.
- **`reminder` is a payment notification.** Its only creators are the overdue
  sweep (`services/payment-reminders.ts`) and the teacher's manual reminder
  (`services/payments.ts`). Class reminders are a separate type,
  `class_reminder`.
- **The fallback email already holds the class id.** `email-fallback.ts`
  passes the whole notification row to `renderNotificationEmail`, so widening
  `NotificationEmailInput` with an optional `relatedClassId` needs no
  call-site change.

## Design

### Route and ownership

`src/app/(student)/bookings/[classId]/pay/page.tsx`, server-rendered, under
the student layout. No tab bar; back link to `/bookings`.

The page looks up the `Registration` by `classId` **and the session's own
`studentId`**, with its `Payment`, the class's calendar entry and teacher. It
never reads a payment or registration id from the URL. No match — the class
does not exist, belongs to no registration of this student, or has no payment
yet — answers `notFound()`. One answer for all of them, so the URL cannot
distinguish another student's class from a missing one.

A `cancelled` registration 404s through the same check: `completeClass`
charges only `CHARGED_STATUSES`, which exclude it, so it never has a payment.

### What the page shows

Header: class type, day and teacher, and the amount (`type-number`).

| Payment status | Teacher has methods | Body |
|---|---|---|
| `pending` / `overdue` | yes | "How would you like to pay?" and one row per method |
| `pending` / `overdue` | no | "Pay {teacher first name} directly — cash or transfer, whatever you two agreed. They'll mark it as received." |
| `paid` | — | "✓ Paid" with the paid date. No methods |
| `not_charged` | — | "⊘ Not charged — {teacher first name} isn't charging for this class." No methods |

`paid` and `not_charged` are settled states, not errors: a notification link
followed after paying lands on a calm, true page.

Below the body, the existing `PaymentBreakdown` ("Where your payment goes")
renders under the same `resolveReportedPaymentBreakdown` gate `/bookings`
uses, in its quiet caption style.

Payment state is text, never a badge (CLAUDE.md, Design Philosophy).

### Method rows

Each method is a `<details name="pay-method">`. A shared `name` makes the
group exclusive in the browser — opening one closes the others — with no
client JavaScript. Rows use the app's disclosure marker, not a chevron: they
expand in place, they do not navigate. Each row shows the method's label and
a one-line hint; its panel holds the method's details.

- **Bank transfer** — the `PaymentDetails` component (built on this branch):
  Name, IBAN and Reference rows, each with a compact Copy pill. The IBAN is
  copied without spaces. A clipboard refusal says so and leaves the value
  selectable by hand.
- **QR code** — the existing `PaymentQr` EPC code, with "Scan with your
  banking app on another device."

No row is open on arrival.

### `src/lib/payment-methods.ts`

```ts
export type PaymentMethod =
  | { kind: 'bank_transfer'; iban: string; beneficiary: string }
  | { kind: 'epc_qr'; iban: string; beneficiary: string };

export function paymentMethodsFor(teacher: {
  bankIban: string | null;
  bankAccountName: string | null;
  firstName: string;
  lastName: string;
}): PaymentMethod[];
```

- Non-blank IBAN → `[bank_transfer, epc_qr]`, in that order. Otherwise `[]`.
- `beneficiary` is `bankAccountName` when non-blank, else
  `"{firstName} {lastName}"` — the one copy of a rule `/bookings` currently
  writes twice.
- Each kind's label and hint live in a table typed
  `satisfies Record<PaymentMethod['kind'], …>`, and the page renders a method
  through an exhaustive `switch` with a `never` default. A kind added by #386
  fails the build at both until handled.
- Amount and reference are per payment, not per teacher, and are passed to
  the page's renderers separately.

An empty list is the single predicate for the "directly" copy, on both pages.

### `/bookings` row

- **Outstanding, methods available** — the **Pay now** compact pill, now a
  `Link` to `/bookings/{classId}/pay`, with an `aria-label` naming the class
  and day so several rows stay distinguishable.
- **Outstanding, no methods** — no pill; a caption line, "Pay
  {teacher first name} directly".
- **Paid / not charged** — unchanged.
- "Where your payment goes" stays, in the quiet caption style.

The inline "How to pay" panel is removed.

### Notification links

- `studentNotificationHref`: `payment_request` and `reminder` with a related
  class return `/bookings/{classId}/pay`, checked by type before the existing
  related-class rule. This reaches the `/bookings` updates strip and
  `/updates`, which both resolve hrefs through it.
- `renderNotificationEmail`: `NotificationEmailInput` gains an optional
  `relatedClassId`. For those two types with a class id, the email carries a
  **Pay now** button to that path; without one, no button, as today.
- Push: unchanged. A push tap opens the inbox at its row, and the row now
  links on.
- The link does not depend on the payment's current status; the page answers
  every status truthfully.

## Testing

Failing test first for each.

- **Unit**
  - `paymentMethodsFor`: IBAN → both methods in order; `null`, `''` and
    whitespace-only IBAN → `[]`; beneficiary falls back to the name when
    `bankAccountName` is null or blank.
  - `studentNotificationHref`: `payment_request` and `reminder` →
    `/bookings/{id}/pay`; existing types unchanged.
  - `renderNotificationEmail`: Pay now button with the class path when
    `relatedClassId` is given; none without it.
- **Component** — `PaymentDetails` (exists on this branch).
- **Integration** (HTTP against the server)
  - Each row of the status table above.
  - Another student's `classId` → 404; a class this student is registered
    for but which has no payment → 404; a nonexistent id → 404.
  - Teacher session → `/schedule`; signed out → `/login?redirect=…`.
  - `/bookings`: outstanding with IBAN links to the pay page; without IBAN
    shows the "directly" line and no link; `not_charged` shows no link. The
    existing "How to pay" assertions in `bookings-page.test.ts` move here, not
    away.
- **Mutations** — removing `studentId` from the ownership lookup must fail
  the other-student 404 test; testing the IBAN with `!== null` instead of
  for non-blank must fail the `''` test.
- **Visual** — 390px: chooser closed, Bank transfer open, QR open (Bank
  transfer closes).

## Out of scope

- Mollie and Stripe methods themselves (#386).
- A student "I've paid" signal to the teacher — a new payment state; its own
  issue.
- Opening a lone method by default — with an IBAN there are always two.
- Any teacher-side change.
