# Signup ticket vs session: one precedence rule, one place

**Issues:** #428 (teacher-side account switch, open), #421 (should a sign-in
link cancel an in-flight signup — a Decision, resolved here), plus one
previously unfiled defect found while writing this spec.

**Measured against `6bf2642b`.** Every file:line below refers to that commit.

## The property, not the bugs

Three defects in this cluster share one cause: **the teacher and student
signup families are parallel implementations, and they diverge.** The
divergence has produced a separate bug each time it happened, in a different
file, found by a different sweep:

| Divergence | Teacher side | Student side | Filed as |
|---|---|---|---|
| Ticket-vs-session precedence | reads the ticket unconditionally (`teacher-profile/route.ts:40-41`) | reads it only when no session cookie is present (`student-profile/route.ts:43-45`) | #428 |
| Signup destination | dropped for existing accounts (`teacher-signup/route.ts:42`) | passed unconditionally (`student-signup/route.ts:66`) | unfiled until now |
| Page identity precedence | ticket wins over session (`signup/profile/page.tsx:40-44`) | n/a — no equivalent page | unfiled until now |

Fixing three guards leaves the property that generated them intact, and a
fourth divergence available. This spec removes the property for the layer
that has been generating them.

The project has answered this exact shape three times already —
`generateEntriesForRule` under a `GeneratorFamily` descriptor (#284),
`ScheduleRule` (#298), `CalendarEntry` (#327). CLAUDE.md states the #284
rationale in terms that transfer without modification: *one rule, one
generator, so the week key and the skip reasons are the same code on both
sides.*

## The rule

> **A session always beats a ticket.** The ticket is the credential for "no
> account yet"; the session is the credential for "the account exists." They
> are never both honoured. What survives a sign-in is the *destination*, not
> the *ticket*.

Both halves matter, and they are independent:

- **Precedence** closes #428 and settles #421.
- **Destination** is what keeps "an existing account becomes a teacher"
  working, and it involves no ticket at all — `magic-link/verify` mints a
  ticket only in its `!resolved` branch (`verify/route.ts:44`), so an address
  that already has an account never gets one.

Conflating them yields a fix that handles the ticket case and still drops the
intent. They are specified separately below.

## Use cases this must satisfy

1. **A teacher starts signup, then remembers they already have a login.**
   Signing in cancels the pending signup. Correct and intended — the typed
   content is not lost regardless, since `profile-setup-form.tsx:30` persists
   a draft to `localStorage` under `fair_yoga_profile_draft`, independent of
   the ticket.
2. **A student starts signup, then remembers they already have a login.**
   Same.
3. **A student starts the *teacher* signup.** Must remain possible: they sign
   in with the existing account and continue into teacher setup, arriving at
   the profile form with their own address. **Broken today** — see *Defect 2*.
4. **A browser holds a ticket for one address and signs in as another.**
   The session wins, the ticket is cancelled, and the user is told. Decided
   in brainstorming; it is what makes #428's vector unreachable rather than
   merely guarded.

## The three defects

### Defect 1 — teacher-profile honours a ticket while a session exists (#428)

`teacher-profile/route.ts:40-41` reads and consumes `SIGNUP_TICKET_COOKIE`
before any session check. When the ticket wins, line 77 creates a **new**
`Account` (`account: { create: { email: auth.email } }`) and line 84 mints a
session over the caller's. `student-profile/route.ts:43-45`
was fixed for this in `a817142a`; the teacher route was not in that commit.

### Defect 2 — the teacher signup destination is dropped for existing accounts

`teacher-signup/route.ts:42`:

```ts
redirectTo: existing ? undefined : '/signup/profile',
```

An address that already has an account gets a `sign_in` link with **no
redirect**. `verify/route.ts:60-62` then falls back to the role default, so a
student who types their address into "Start teaching on fair.yoga" is signed
in and dropped on `/bookings` — no message, no path onward. Use case 3 dies
at this line.

`student-signup/route.ts:66` passes `redirectTo: redirect` unconditionally.
The student family has always been correct here.

This is *not* an account-enumeration leak: the destination lives inside the
email, which only the address owner sees, and both branches answer an
identical 200. It is an inconsistency, and it breaks a flow.

### Defect 3 — the profile page's precedence is the inverse of the route's

`signup/profile/page.tsx:40-44` resolves identity ticket-first, and says so:
*"The ticket wins where both exist, which is the order the route resolves them
in too."* True when written. Once Defect 1 is fixed the two disagree, and the
consequence is not cosmetic: a signed-in visitor holding a stale ticket gets a
`ticket`-mode form prefilled with **another address**, which renders and then
401s on submit, because the route now ignores the ticket the page displayed.
`mode` also drives the copy and the 401-recovery branch
(`profile-setup-form.tsx:274`), so the two must move together.

## Design

### The shared resolver

New module `src/lib/auth/profile-authorization.ts`, beside `signup-ticket.ts`.
Not `src/services/` — it touches `NextRequest`/`NextResponse` cookies, and
CLAUDE.md keeps services framework-agnostic. `api-utils.ts` already holds the
HTTP-aware `requireSession`, which is the established altitude for this.

```ts
export type ProfileAuthorization<TBody> =
  | { source: 'ticket';  email: string; body: TBody }
  | { source: 'session'; email: string; session: SessionUser; staleTicketCookie: boolean };

export type ProfileAuthorizationOutcome<TBody> =
  | { ok: true;  auth: ProfileAuthorization<TBody> }
  | { ok: false; reason: 'invalid_body' | 'no_session'; response: NextResponse };
```

`reason` is redundant to today's callers, which return `response` verbatim.
It is there so the two failures stay distinguishable to tests and to the next
refactor — the distinction that vanished when `add-room-flow`'s two fetch
branches collapsed into one `throw` (PR #261).

`staleTicketCookie` reports that a ticket cookie was present and deliberately
ignored, so the session path can clear it and a stale ticket is reaped by the
next authenticated write instead of lingering for its full hour.

**Flow — the entire bug surface, in one function:**

```
1. ticketToken = session cookie present ? undefined : ticket cookie    <- THE RULE
2. if ticketToken:
     peek (non-consuming)
     if live:  parse body -> on error: { ok: false, reason: 'invalid_body' }
               consume; take the email from the CONSUMED value, never the peek
               if consumed: { ok: true, source: 'ticket' }
               else:        log.warn(peeked live, did not consume); fall through
3. requireSession -> on error: { ok: false, reason: 'no_session' }
4. email <- account.findUniqueOrThrow(session.accountId)
5. { ok: true, source: 'session' }
```

Step 1 uses cookie **presence**, not validity, so an invalid session cookie
surfaces `requireSession`'s own 401 rather than falling through to someone
else's ticket. Steps 2 and 4 remove duplication both routes carry today.

### Two wrappers, one core

The families disagree about whether the *session* path carries a body, and the
difference is essential: a student adding the teacher hat still fills in name,
bio and page address, while `JoinAsStudent` POSTs nothing and copies names
from the teacher profile. Two exported wrappers over one internal core:

- `resolveProfileAuthorization` — body on both paths (teacher)
- `resolveTicketOnlyProfileAuthorization` — body on the ticket path only (student)

The rule, the ordering and the email source live in the core. Only the return
type's shape forks, checked by the compiler at both call sites; choosing the
wrong wrapper fails to compile.

**Rejected:** a single function returning `body: TBody | null` on the session
branch. It forces the teacher route to check a state that cannot occur, making
an impossible state representable.

**No family descriptor.** `GeneratorFamily` exists because several correlated
facts per family must not be mismatched (a `childTable` spliced into a raw row
lock). Here one fact varies — the `SignupFamily` literal, already
compiler-tethered by `TICKET_PURPOSE`'s `satisfies Record<SignupFamily,
MagicLinkPurpose>` in `signup-ticket.ts`. A descriptor holding one field is
ceremony. Its docblock records that a second correlated fact is when the
descriptor earns itself.

### Call sites

**`teacher-profile/route.ts`** — loses the cookie read, the peek/consume, the
session `account` fetch, and its locally-declared `Authorization` type. Keeps
the `ALREADY_TEACHER` check, the `teacher.create` payload, `SLUG_TAKEN` with
its ticket re-mint, the conflict census, and the `P2002` → `log.error` +
throw. The #428 fix arrives as a consequence of calling the resolver, not as a
guard someone added.

**`student-profile/route.ts`** — loses the same four. Keeps `ALREADY_STUDENT`
/ `NO_PROFILE_SOURCE`, the teacher-name copy, the unclaimed-CRM-row claim with
its early return, the `accountId` null guard, and the ticket-vs-session
distinction in its email-conflict handling (`ACCOUNT_EXISTS` with its log line
versus `ALREADY_STUDENT`).

**`signup/profile/page.tsx`** — precedence flips to session-first; the comment
asserting the opposite goes with it.

**Both routes** — clear the ticket cookie on the session path when
`staleTicketCookie`.

### Destination symmetry

`teacher-signup/route.ts:42` passes `TEACHER_PROFILE_PATH` unconditionally —
the constant `signupTicketFor` already uses, rather than the string literal
the route hardcodes. `/signup/profile` sorts arrivals on its own: already a
teacher → `/schedule`; student → the session-mode form. That is the whole of
use case 3.

### The passkey door

Census, re-derived with:

```bash
grep -rn "setSessionCookie(" src/app src/lib | grep -v "\.test\."
```

Five sites at `6bf2642b`: `magic-link/verify:65`, `claim:70`,
`passkey/authenticate/verify:63`, `teacher-profile:84`, `student-profile:189`.
Four of them clear the ticket cookie in the same response — `verify:70`,
`claim:75`, and the two profile routes, which have just consumed it. The
passkey door does not, and gains `clearSignupTicketCookie`.

This is **hygiene, not the fix**. Once the resolver refuses to read a ticket
while a session cookie exists, a stale cookie is inert; this stops it riding
along. The count above lives here rather than in a comment because a census
reaching past its own file has no owner.

### Cancellation visibility (#421)

`magic-link/verify` and `claim` return `signupCancelled: true` when they
dropped a **live** ticket, established by a new family-agnostic
`signupTicketIsLive(db, token)` — one read on the `tokenHash` unique index —
rather than by cookie presence, so a long-dead cookie cannot produce a false
"we cancelled your signup."

The surface is `(public)/verify/page.tsx`, already a client component holding
that response and rendering a `Status` before the user moves on: the
cancellation becomes a line in its success state. No flash cookie, no query
parameter, no notice plumbed into three possible destinations.

**#421 closes as working-as-intended**, with use cases 1 and 2 as the recorded
rationale. Its option 2 (exempt tickets from `consumeTokenRow`'s sibling
purge) is rejected on its own terms: `verify:70` and `claim:75` already clear
the ticket cookie in their session-issuing branches, so preserving a row whose
only bearer the same response deletes returns nothing to the user. Delivering
option 2's promise would require *not* clearing the cookie, which is the
configuration #428 documents as an account-switching vector.

## Test plan

Tests precede the extraction.

**New — `tests/integration/teacher-profile-precedence.test.ts`.**
`teacher-signup-api.test.ts` already covers `teacher-profile`'s ticket path
(create, spent ticket, `SLUG_TAKEN`, the #161 race, timezone — lines 268-478)
and its session path (line 680, "creates the teacher on the signed-in account,
with no ticket"). What no test anywhere presents is **both cookies on one
request**, which is exactly #428. A new focused file rather than growing a
720-line one, with self-contained fixtures so it does not depend on that
file's shared `beforeAll`. Red before the resolver exists:

- session cookie + live ticket for another address → session path wins; no
  second account; the caller's session unchanged *(the #428 regression test)*
- **invalid** session cookie + live ticket → 401 from `requireSession`, ticket
  not spent — presence, not validity
- ticket only, no session → teacher + account created, session minted, ticket
  cookie cleared
- a student ticket presented here → consumed, discarded, falls through
- session path with a stale ticket cookie → `clearSignupTicketCookie` on the
  response

**New — `src/lib/auth/profile-authorization.test.ts`.** Both `reason` values
distinctly; the peeked-live-but-consume-lost `log.warn` path; the returned
email comes from the consume, not the peek.

**Extended** — `teacher-signup-api.test.ts` asserts the destination for both
the existing-account and new-account branches, plus a test asserting *both*
signup routes pass their destination regardless of account existence. That
test is Defect 2's tether: a future conditional on either side turns it red.
`signup/profile/page.test.tsx` gains session-first precedence.

**Two mutation checks.** Flip the precedence inside the resolver and confirm
the new teacher tests go red — a test that cannot fail is not watching the
guard. Confirm the *student* tests go red under the same mutation: they now
exercise shared code, and a shared fixture is exactly where siblings start
passing for a new reason.

**One review step, not a test.** After the extraction commit, read the
**removed** hunks for `student-profile`'s `ACCOUNT_EXISTS` vs
`ALREADY_STUDENT` distinction and its `accountId` null guard. Both are in this
diff, neither has a test watching it, and error-branch collapse is the
documented failure mode of extractions in this repo.

## Out of scope

- A discoverable "add teaching to my account" entry point inside the
  signed-in student experience. `/signup` already redirects a signed-in
  teacherless visitor to `/signup/profile`, so use case 3 is reachable;
  making it *findable* is a separate issue.
- The reverse direction (a teacher adding the student hat). Both halves are
  already correct: `student-signup` passes its redirect unconditionally, and
  `student-profile/route.ts:98` opens the session branch that serves it.
- Unifying the two routes' profile *creation*. The genuine differences live
  there — the CRM-claim early return, `SLUG_TAKEN` re-minting, per-family
  unique-key censuses — and forcing them through one shape would be the
  unification that earns its own bug. Both divergences to date are on the
  authorization side.
