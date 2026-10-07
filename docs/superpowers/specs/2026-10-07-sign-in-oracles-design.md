# Sign-in oracles (#767) — design

Three findings from the 2026-10-05 API security review, each re-traced in code
before designing on it. Two hold as written; one holds and is worse than the
issue says.

## 1. Premise check

### 1.1 `magic-link/send` timing — holds, plus a second, smaller channel

`src/app/api/auth/magic-link/send/route.ts` answers a uniform body and sets the
nonce cookie for every accepted request. But only a registered address reaches
`await deliverSignInLink(...)` — a token insert plus the awaited provider call
in `sendMagicLinkEmail` — so a registered address's 200 arrives later by
however long that call takes.

The issue does not mention the lookup itself: `teacher.findUnique` and, only on a miss,
`student.findUnique`. A teacher address costs one query, a student or unknown
address two. That is a sub-millisecond difference, not hundreds of milliseconds,
but it is the same kind of channel, and the fix below closes it for free by
moving the lookup off the response path as well.

"The invitation and signup routes already avoid this" holds in the sense that
matters: `teacher-signup` and `student-signup` deliver for every address, so
both branches do the same work. Their `purpose` differs by registration, their
latency does not.

### 1.2 Handoff code guessing — holds, and the per-token bound is not hard either

Re-derive the inputs with:

```
grep -n "PER_EMAIL_LIMIT\|'teacher-signup:email'\|'student-signup:email'" \
  src/app/api/auth/magic-link/send/route.ts src/app/api/auth/teacher-signup/route.ts \
  src/app/api/auth/student-signup/route.ts
grep -n "HANDOFF_MAX_ATTEMPTS =" src/lib/auth/handoff.ts
```

Three doors mint a sign-in token for an existing address, each with its own
per-address budget of 3 per 15 minutes: 3 × 3 = 9 tokens per window. Each
token, once a JS-running scanner has stamped it, absorbs
`HANDOFF_MAX_ATTEMPTS` = 5 wrong guesses before it is deleted. Per day:
9 × 5 × 96 windows = 4,320 guesses against a 10⁶ space ≈ 0.43%, the issue's
"roughly 0.4%". The per-IP limits fall to IP rotation, as the issue says.

The issue describes the budget as "5 guesses per token". The code charges per
*browser* (`claimWithCode`, the 2026-09-08 attempt-budget spec): a miss is
charged to every stamped candidate under the guessing nonce. Since the attacker
owns that nonce and decides how many of the victim's tokens sit in it at once,
the yield is the same 5 per token. The arithmetic stands.

**What the issue misses: concurrency.** `claimWithCode` reads its candidates,
compares the submitted code against that snapshot, and only *then* increments
`handoffAttempts`. N concurrent wrong guesses all read the counter before any
of them writes it, so all N are compared. The per-token 5 is a bound on
*sequential* guesses only. A concurrent burst is one-shot per token, because
the same calls' `deleteMany … gte 5` reaps the row afterwards, but one burst
of B guesses (at most 30 per IP, times the number of IPs, limited in practice by
request concurrency) can land on each of the 9 tokens per window.
`docs/superpowers/specs/2026-09-08-handoff-attempt-budget-design.md` §4
("Concurrency") argues that two concurrent misses still *count* as two. It does
not consider that both were *compared* before either was counted. The fix below
has to be race-free on its own account, or the issue's IP-rotating attacker
walks around it the same way.

**A second multiplier: one claim compares the guess against every live code.**
`live.find((c) => c.handoffCode === code)` tests one guessed value against every
stamped candidate under the nonce, so an attacker holding k of the victim's
stamped tokens under one nonce gets k chances per request. Any budget that
counts *claims* rather than *codes compared* is off by that factor.

### 1.3 `students/[id]` 403-vs-404 — holds, for two session kinds

`GET /api/students/[id]` looks the student up first and answers 404 for an
unknown id. For an existing one it answers 403 "Student not in your contacts" to
an unlinked teacher, and 403 "Access denied" to any other non-owner session (a
different student, for instance). Both are existence oracles. The route's own
comment says the link check exists to prevent "the confirmation that this id is
a student at all", and the 403 is that confirmation.

`PUT` refuses every non-owner with 403 before any lookup, and `PATCH` maps the
service's `not-linked` outcome to one 403 whether the student exists or not.
Neither is an oracle.

No client in `src/` issues a GET to this route: its client callers are all PUT
or PATCH. The 404 therefore changes no UI. The existing pin
`'a student-only session reading another student is denied'` in
`tests/integration/students-api.test.ts` flips from 403 to 404.

**The shape is wider than this route.** A read-only sweep of the dynamic
segments under `src/app/api/` (`find src/app/api -path '*\[*' -name route.ts`)
found the same 404-vs-403 split in the classes, class-templates,
studio-class-templates, studio-classes, payments, rooms, teacher-rooms,
registrations, notifications and waitlist handlers. All are keyed by Prisma
`uuid()` ids, and none is reachable anonymously. They are **not** changed here.
What they confirm is that a business record exists, not that a person does.
Moving the whole API to "404 for not-yours" is a convention decision with UI
consequences: several clients read the registered `NOT_FOUND` code as "already
gone, treat as success" (`delete-room-button.tsx`, `delete-studio-class-button.tsx`,
`cancel-booking-button.tsx`), so a blanket 403→404 would make an unauthorised
delete look like a success. `students/[id]` is fixed because its subject is a
person and its own comment already promises the property.

## 2. Design

### 2.1 Send without waiting

A new `deliverSignInLinkIfRegistered(db, email, nonce, opts): FireAndForget`
beside `deliverSignInLink` in `src/lib/auth/link-delivery.ts`. It owns the
lookup *and* the delivery inside one detached async body with its own `.catch`
that logs, the shape of `deliverPasskeyAddedNotice`
(`src/services/passkey-notice.ts`). Nothing runs before the detached body, so
nothing can throw into the caller.

The route calls it with no `await`, and its existing `try/catch` and the
comment justifying it go, since there is no longer a promise to reject into the
route. The uniform body, the nonce cookie set before the call, and the rate
limits are unchanged.

The return type is pinned with
`Assert<Equals<ReturnType<typeof deliverSignInLinkIfRegistered>, void>>`, as
`deliverInvitation` is. Widening it back to `Promise<void>` is the realistic
regression, and the pin fails to compile on it.

The signup routes keep awaiting `deliverSignInLink`. They have no
registered/unregistered asymmetry in work done, and `student-signup` reports
`delivered` in its body (`BookingNameStep`'s resend copy keys on it), which
needs the outcome.

### 2.2 One comparison budget per address, reserved before comparing

A new table:

```prisma
model HandoffAttemptBudget {
  email          String   @id
  windowStartsAt DateTime
  attempts       Int
}
```

The migration adds `HandoffAttemptBudget_email_lowercase_check`, as every
email column carries one (#170). The key is canonical today because
`MagicLinkToken.email` is lowercase, and the CHECK keeps it so against a future
writer.

`HANDOFF_EMAIL_MAX_ATTEMPTS = 10` **code comparisons** per
`HANDOFF_EMAIL_WINDOW_MS = 24h`, a fixed window per address. The unit is one
code compared, not one claim: §1.2's second multiplier means a per-claim
budget is off by the number of the address's live codes.

`claimWithCode`, after reaping spent candidates and computing `live` (newest
first), groups `live` by address. For each address in turn it asks for as many
comparisons as that address has live candidates, and is **granted**
`min(wanted, remaining)`. It then compares the submitted code against the
granted number of that address's candidates, newest first. A grant of zero
means none of that address's candidates is compared. If nothing at all was
granted, the claim is `invalid`, with the same answer and message as any other
failure. The code is matched against the granted candidates in `live` order,
not address by address, so when two addresses' granted candidates share a code
the newest token wins, whatever the grouping. The per-token `handoffAttempts` charge on a miss applies to compared
candidates only, because a candidate that was never compared was never guessed
at.

A partial grant compares the newest candidates first. That is not "compare only
the newest", which `2026-09-08-handoff-attempt-budget-design.md` §3 rules out
because it would make an older open-elsewhere code permanently unclaimable. A
partial grant only happens when the address is about to run out, and the next
window compares everything again.

The reservation is `reserveHandoffComparisons(db, email, wanted, now):
Promise<number>`, one interactive transaction with Prisma's default options:

1. `setLockTimeout(tx)`, the repo's shared 2 s `SET LOCAL lock_timeout`, so a
   wait on the row is bounded by the database rather than by Prisma's
   transaction timeout, which cannot bound a blocked statement.
2. A typed `createMany` with `skipDuplicates` (`INSERT … ON CONFLICT DO
   NOTHING`), with `attempts = 0` and `windowStartsAt = now`, so the row exists
   to lock. Concurrent first-ever inserts are safe, because the loser does
   nothing.
3. `SELECT attempts, "windowStartsAt" … WHERE email = $1 FOR UPDATE`, which
   locks the row. Concurrent claims for the address queue here. If the row
   existed at the insert and another writer deleted it before this read, the
   read finds nothing: steps 2 and 3 run once more, and the second insert
   creates the row. A row still missing after that second pass throws.
4. In TypeScript: if the window has ended, `used = 0` and the window restarts
   at `now`; `granted = min(wanted, max − used)`.
5. A typed Prisma `update` writes `attempts = used + granted` (and the
   restarted window, if any), then the transaction commits.

Binding is typed Prisma except the `FOR UPDATE` read, which binds only the
address, so no `Date` passes through a raw parameter. A `Date` in raw SQL binds
as `timestamptz` against this `timestamp(3)` column and would convert through
the session time zone.

**A wait past the lock timeout answers 503, not the uniform 400.** The
reservation fails with `55P03`, the route's error handler answers a transient
503, nothing is granted for that address, and the claim is not compared. This
is a ruling, not an oversight: the wait depends on a concurrent holder of the
address's budget row (another claim for the address, or its erasure), not on the
guessed code, so the status reveals nothing about the code. A claim spanning
two addresses reserves them one transaction at a time, so if the second times
out the first address's grant is already committed and is spent without a
comparison. That is accepted: it costs a shared-browser legitimate user a
comparison under contention and never helps an attacker.

Why reserve before comparing, not charge after a miss:

- **Race-free by construction.** The row lock serialises reservations for an
  address, and each grant is spent before the comparison runs. However many
  claims arrive at once, the comparisons for one address within one window
  total at most 10. Charging after a miss would repeat §1.2's snapshot defect
  one level up.
- **A correct code spends too.** A legitimate cross-device sign-in costs one
  comparison per live stamped token for the address. That is usually one, or
  two after a resend with both links opened elsewhere. Typos cost the same per
  try. Ten covers several fumbled attempts, and nobody signs in by code ten
  times a day.

Bound after the fix: 10 comparisons per address per day against 10⁶ codes, so
10⁻⁵ per day and ≈ 0.37% per year (3,650 / 10⁶). That holds whatever number of
tokens the attacker stacks, including past the in-memory minting limits.
Before: ≈ 0.43% per day.

**Why per address and not per nonce:** the attacker owns the nonce, and §1.2
shows that a per-nonce budget is the one being walked around. Every token for
the victim's address, minted from any door and stamped under any nonce, draws
on the one budget.

**The availability cost, accepted:** an attacker who already satisfies the
attack's preconditions (a scanner that stamps the victim's links) can spend the
victim's 10 comparisons and block the *code* path for that address for up to
24 hours. The same holds for an address that has no account yet, blocking
code-path signup for it. Opening the link on the device that requested it is
unaffected (`verifyWithHandoff`'s same-browser branch never touches the budget),
and so are passkeys. The refusal copy stays the uniform "That code did not work.
Ask for a new link."

**Shared browsers:** charging every live address under the nonce means one
person's typo spends a stranded earlier user's comparison too. This is the same
sharing that the 2026-09-08 attempt-budget spec §5 accepted per token, now per
address. That stranded token expires within 15 minutes regardless. A multi-address claim
whose second reservation times out also spends the first address's grant
uncompared (§2.2).

**Retention, erasure, export:**

- `cleanupExpiredAuth`, the daily sweep, deletes rows whose window has ended. A
  row therefore lives at most 48 h after its window started: a 24 h window plus
  up to one daily sweep interval.
- Both erasure paths in `src/services/gdpr.ts` that delete `magicLinkToken` rows
  by address also delete this table's row for that address.
- The row stores the plain address, not a hash. `MagicLinkToken.email` sets the
  precedent, and erasure deletes the row rather than relying on a hash being
  opaque.
- The row is not part of the GDPR data export, on the same basis as
  `MagicLinkToken`: it is short-lived security state about sign-in attempts,
  not data the person provided.
- `gdpr.ts`'s comment listing the email columns by name and count is replaced
  with one that names the CHECK convention instead (Comment Discipline).

**Locks:** reservations hold one budget row at a time, in a transaction that
takes no other lock. Erasure deletes one budget row after its profile locks.
The daily sweep's multi-row delete is autocommit and can wait on a row the
erasure holds, and the erasure can wait on the one row both touch if the sweep
already holds it; neither then waits on anything the other holds. No cycle
forms, by the argument `docs/lock-order.md` makes for the notification
retention sweep against erasure (#223). `docs/lock-order.md` has no node for
`MagicLinkToken`, `Session` or `PasskeyCredential` either, because its census
covers tables a transaction takes two of. So this table gets no node. It appears in `docs/lock-order.md` only as a
standing exception in the `FOR UPDATE` census and as one line in the
`setLockTimeout` census.

### 2.3 `students/[id]` GET: one 404 for "not yours"

Every caller who is not authorized for the id gets the same `404 'Student not
found'` as an unknown id. Self-access and the linked-teacher projection are
unchanged. The order of checks changes so that nothing about the row's
existence is observable before authorization fails.

## 3. Rejected

- **Replace `/verify`'s auto-POST with a "Continue" button.** This costs every
  sign-in a tap, which is the friction the handoff design exists to remove.
  It also only stops scanners that run JS but do not click, and some click.
  With §2.2 in place the bound holds whatever the scanner does, so the button
  would buy nothing measurable.
- **The in-memory rate limiter for the address budget.** It loses state on
  restart and evicts the least-recently-used bucket under capacity pressure.
  An attacker can stamp tokens for their own catch-all addresses (the
  attempt-budget spec §1 shows how) and so can flood the partition to evict the
  victim's bucket. The 2026-09-08 spec's argument that rate limits are the wrong
  instrument for this bound applies again.
- **Refunding the reservation on a correct code.** This is a second write on
  the success path to return one comparison of ten, and nobody would notice the
  difference.
- **One atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` instead of a
  transaction.** It can cap a counter, but it cannot report how many units a
  *partial* grant gave, because `RETURNING` sees only the new value, not the
  old one, before PostgreSQL 18. It would also bind `Date`s raw.
- **The other 404-vs-403 handlers** (§1.3, with the command that finds them).
  They are a convention decision, not this issue.

## 4. Tests and the guards they must prove

| Guard | Test | Mutation that must turn it red |
|---|---|---|
| `send` does not await delivery | type pin on `deliverSignInLinkIfRegistered`'s return | declare `Promise<void>` and `await` it in the route → compile error |
| lookup is off the response path | unit: the function returns `undefined` synchronously while a stubbed lookup never settles | move the lookup out of the detached body |
| a delivery failure is logged, not thrown | unit: a rejecting lookup or send results in `log.error` and no unhandled rejection | drop the `.catch` |
| registered address still gets its token | integration: poll for the token row after `send` (it no longer exists when the 200 lands) | skip delivery → the poll times out |
| tests that read a token after `send` stop racing | `auth-email-case.test.ts` (poll), `tests/e2e/auth.spec.ts` (poll), and `magic-link-claim.test.ts` (wait for the background token before the claim, so the claim's sibling purge cannot be outrun by a late insert) | — (flakiness fix) |
| budget spans tokens and nonces | DB: one address; T1 under N1 takes 4 misses, T2 under N2 takes 4, T3 under N3 takes 2 (no token reaches the per-token 5); then T3's **correct** code under N3 is `invalid` and T3 still exists | key the budget per token or per nonce |
| only granted candidates are compared | DB: addresses A and B under one nonce, A's budget spent: A's correct code is `invalid`, B's correct code verifies | compare all of `live` regardless of grant |
| a claim spends one unit per code compared | DB: three stamped tokens for one address under one nonce, one wrong claim → `attempts` is 3 | charge 1 per claim |
| a partial grant compares newest first | DB: budget at 9, two stamped tokens under one nonce: the older one's correct code is `invalid`; on a fresh setup, the newer one's verifies | grant all-or-nothing, or compare oldest first |
| reserve precedes compare | DB: 20 stamped tokens for one address, each under its **own** nonce, then 20 concurrent wrong claims, one per nonce. No token gets more than one increment, so none is reaped. Σ`handoffAttempts` = 10 and the budget's `attempts` = 10. Make sure the calls really overlap: hold the budget row's lock on a second connection while all 20 are issued | charge after the miss instead of reserving before → Σ = 20 |
| a lock wait past the timeout fails closed | DB: a second client holds the budget row for longer than the lock timeout and shorter than Prisma's own: `a claim held past the lock timeout fails as a transient 503, and nothing is spent` asserts the claim settled inside the hold, the error is a lock timeout classified 503, and neither the budget nor the token's `handoffAttempts` moved | delete `setLockTimeout(tx)` → the claim waits out the hold and is granted |
| a vanished row is recreated | DB: `grants from a fresh window when the row is deleted between the insert and the lock` stages a delete between the two statements | loop once instead of twice → `handoff: budget row missing after insert` |
| the newest granted token wins across addresses | DB: `a code two addresses share claims the newer token, whatever the address grouping`: live order [A-newest, B, A-older] against grouped order [A-newest, A-older, B], the shared code verifies B | match in `compared`'s order instead of `live`'s → verifies A-older |
| window resets | DB: a row whose window started more than 24 h ago (written through typed Prisma) grants again, and reads back with `attempts` = the new grant and `windowStartsAt` equal to the JS `now` | drop the window-ended branch |
| the same-browser path ignores the budget | DB: budget spent, `verifyWithHandoff` with the matching nonce still verifies | — |
| addresses are lowercase | DB: inserting an uppercase address is refused by the CHECK | drop the CHECK |
| sweep reaps ended windows | DB on `cleanupExpiredAuth`: a stale row is reaped, a fresh one kept | drop the delete |
| erasure deletes the row | the existing erasure tests on both gdpr paths | drop the delete |
| `students/[id]` GET is uniform | integration: an unlinked teacher and another student both get exactly the unknown-id status and body | restore the 403 |
