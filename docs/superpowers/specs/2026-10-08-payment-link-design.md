# A teacher-provided payment link as a Level 1 pay method (#785)

## Decisions (from the issue author, 2026-10-08)

The issue left four questions open. The author answered three when commissioning
the work; the fourth was already settled in the issue:

- **One link per teacher**, not one per currency. The link is shown for every
  payment whatever its currency — PayPal.me is multi-currency, and a teacher
  whose link only takes one currency (Tikkie) chooses what to enter.
- **A link alone satisfies the onboarding `bank` step.**
- **Additive**: a teacher with a bank account and a link offers both — transfer,
  QR (EUR) and link. Level 2 (Mollie/Stripe, #386) is later and separate;
  **#386 is unaffected**.
- Changing the link is a payout-details change for the alert in #786; that
  issue stays open and gains a comment naming the link's route. **#786 is
  unaffected** by this PR's code.

## The premise, as measured (worktree at `de352d49`)

What held:

- A non-euro account gets a transfer and nothing else
  (`paymentMethodsFor`, `src/lib/payment-methods.ts` — the QR branch is gated on
  `details.scheme === 'sepa'` and `EPC_QR_CURRENCY`).
- `docs/product-concept.md` (Level 1: Direct Payment) promises "Tikkie, cash, or
  any other method the teacher accepts"; nothing in the app carries a link.
- `PAYMENT_METHOD_COPY` is `satisfies Record<PaymentMethodKind, …>` and the pay
  page's `MethodPanel` switch ends in `never`.

What did not: the issue says those two tethers "name every site that must handle
it". They name only the two sites that *render* a method. There are six calls to
`paymentMethodsFor`: the pay page, the bookings page, `class-lifecycle`
(completion notification), `email-fallback`, `payment-reminders`, and `payments.ts`
(manual reminder). Re-derive the list with
`grep -rn "paymentMethodsFor(" src | grep -v "\.test\." | grep -v "export function"`. Every one except the pay page reduces the result to
`.length > 0`, a "has methods" boolean that picks between a Pay-now
link/button and "pay your teacher directly" copy. All of them pass only the bank
account (`teacher.bankAccounts` read through `bankAccountSelect`). A new union
member would compile clean while every email and the bookings list kept telling a
link-only teacher's students to pay directly. **The tether therefore has to be on
`paymentMethodsFor`'s input, not on the union**: a required input means each
call site fails to compile until it reads the link.

## Data

One nullable column on `Teacher`:

```prisma
paymentLink String?
```

A hand-authored CHECK (pattern: `20260721061528_student_claim_link_check`):

```sql
CHECK ("paymentLink" IS NULL OR ("paymentLink" LIKE 'https://%' AND char_length("paymentLink") <= 500))
```

The CHECK is a backstop for the scheme and length. The full rule is the service's,
because "parses as a URL" is not SQL.

A column, not a table. One link per teacher has no key of its own. Erasure
already scrubs `Teacher` columns in one `updateMany`, and the bank-account
table exists only because accounts are per currency.

## Validation — `src/lib/payment-link.ts` (client-safe, no `server-only`)

`PAYMENT_LINK_MAX = 500` lives in `src/lib/input-bounds.ts` beside the other
bounds, and the CHECK repeats the literal. `parsePaymentLink(raw: string)` returns
`{ ok: true; url: string; host: string }` or `{ ok: false; error }`:

1. Trim. An empty string is `required`, and length over the max is `too_long`.
2. `new URL(trimmed)`. If that throws, `invalid`.
3. `protocol !== 'https:'` gives `not_https`. This refuses `http:`, `javascript:`,
   `data:` and every other scheme, so there is no denylist.
4. Userinfo present (`username` or `password` non-empty) gives `invalid`. In
   `https://revolut.me@evil.example/` the visible start of the URL is not its
   host, and the button's host label exists to defeat exactly that.
5. The stored value is `url.href`, the normalised form.
6. The host is `url.hostname` with one leading `www.` dropped. It is shown on
   the button as "Pay via revolut.me". An IDN host is shown as the punycode
   `hostname` produces, which keeps a look-alike visible.

There is no allowlist of services (issue: "would defeat 'any link'") and no
amount templating (issue: out of scope).

`paymentLinkFromColumn(stored: string | null)` re-parses a stored value for
rendering. It returns `null` for a value that does not parse, which the CHECK and
the service make unreachable. `paymentMethodsFor` logs that case like an
unparseable bank row and offers no link.

## Methods — `src/lib/payment-methods.ts`

```ts
| { kind: 'payment_link'; url: string; host: string }
```

`PAYMENT_METHOD_COPY.payment_link = { label: 'Payment link', hint: 'Pay in the app the link opens' }`.

`paymentMethodsFor` takes one object:

```ts
paymentMethodsFor({ teacherId, account, paymentLink }: {
  teacherId: string; account: StoredBankAccount | null; paymentLink: string | null;
}): PaymentMethod[]
```

The order is the bank methods as today (transfer, then QR for EUR), then the
link last. A link with no account yields `[link]`. An unparseable account still
yields the link, because the two are independent sources and one failing does not
hide the other. `teacherId` is in the input because the link-only path has no
account row to name the teacher in a log line.

`teacherPaymentSelect` names the columns every consumer reads, so consumers do not
each spell out `paymentLink: true`:
`{ id: true, paymentLink: true, bankAccounts: { select: bankAccountSelect } }`
(`satisfies Prisma.TeacherSelect`). `paymentMethodsForTeacher(teacher, currency)`
wraps the lookup each consumer does now, `accountInCurrency(teacher.bankAccounts, currency)`.
Each of the six call sites moves to it.

## Pay page

`MethodPanel` gains `case 'payment_link'`. It shows the amount and the reference
with the same copy pills the transfer panel uses, so the student can type them
into whatever the link opens. Below them is a primary-styled anchor reading
`Pay via {host}`, with `href={url}`, `target="_blank"` and
`rel="noopener noreferrer"`. A caption says the teacher marks the payment received
once it arrives, as the transfer panel's does.

## Teacher settings

- **Route:** `PUT /api/teachers/[id]/payment-link` with body
  `{ paymentLink: string }`, and `DELETE /api/teachers/[id]/payment-link`.
  - Both refuse another teacher with 403.
  - An invalid link is a 400 carrying the field message in `parseBody`'s
    `path: message` shape, as `bank-accounts` does. A 400 needs no registered
    code.
  - An erased teacher is a 404.
  - A same-value PUT and a DELETE with no link answer `respondUnchanged`.
- **Service:** `src/services/payment-link.ts`, with `savePaymentLink` and
  `removePaymentLink`.
  - The write is `teacher.updateMany({ where: { id, deletedAt: null } })`, the
    live-row-scoped update the profile PUT uses (`updateTeacherProfile`). Under
    READ COMMITTED a write that waits on the erasure's row lock re-evaluates its
    `WHERE` and matches nothing, so count 0 means `teacher_gone`.
  - It adds no lock site, so `docs/lock-order.md` needs no new entry.
  - The unchanged check reads the current value before writing. Two racing saves
    from the same teacher end with last-writer-wins, which is correct for a
    single field.
- **UI:** a `PaymentLinkForm` (`src/components/settings/payment-link-form.tsx`)
  on `/settings/profile` directly below the bank block. It has one URL input,
  Save, and Remove when a link exists. Its hint reads: "A Tikkie, PayPal.me,
  Revolut or similar link without a fixed amount. Students see it next to what
  they owe." Its structure, error display and refresh follow `BankAccountForm`.

## Onboarding

`StepInput.bankAccountInCurrentCurrency` becomes `payoutDetailsSet`. Both
computing sites (the schedule overview page and `api/account/onboarding`) compute
it as `hasAccountInCurrency(...) || teacher.paymentLink !== null`. The step's
copy becomes "Add how students pay you" / "Bank details or a payment link — skip
if you take cash".

## GDPR

- Export: `paymentLink` joins the `profile` block of `exportTeacherData`.
- Erasure: `paymentLink: null` joins the scrub `updateMany` beside
  `processorAccountId`.

## Docs

- `docs/data-model.md`: a Teacher row for the link, and the
  `TeacherBankAccount` section's methods line.
- `docs/product-concept.md`: the Level 1 line.
- CLAUDE.md (Payment Model, Level 1): one clause naming the link.

## Testing

- Unit:
  - `parsePaymentLink`: https accepted and normalised; `http:`, `javascript:`,
    `data:`, userinfo, blank and over-max each refused with their own error;
    `www.` dropped from the host.
  - `paymentMethodsFor`: link only; account and link; EUR order
    transfer→QR→link; unparseable account plus link gives `[link]`; unparseable
    link gives the bank methods and a logged error.
  - Onboarding: the link alone completes `bank`.
  - The copy record and the union stay tethered by the compiler.
- Component: `PaymentLinkForm` save, error and remove; the pay page's link panel
  (anchor `href`, `target`, `rel`, host label).
- Integration:
  - The route: 403, 400 per refusal, 200, unchanged on the same value, DELETE
    and unchanged-DELETE, 404 for an erased teacher.
  - The pay page shows the link for a link-only teacher.
  - The bookings page shows Pay now for a link-only teacher.
  - The DB CHECK refuses a direct `http://` update.
- Mutation steps in the plan, each breaking a guard and recording the exact
  failure:
  - the https check
  - the userinfo check
  - the CHECK constraint
  - the `|| paymentLink` onboarding clause
  - the link half of `paymentMethodsFor`
  - the erasure scrub

## Out of scope

- Per-service amount templating, and per-currency links.
- An allowlist or reputation check of hosts.
- Level 2 (#386) and the payout-change alert (#786).
