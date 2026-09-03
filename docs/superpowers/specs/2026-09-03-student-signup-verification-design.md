# Student signup: no rows before the address is verified

**Issue:** #399. **Sibling:** #382/#385 fixed the same defect on the teacher
side and built most of the machinery this reuses.

## The defect

`src/app/api/auth/student-signup/route.ts` creates a `Student` and an
`Account` from an unauthenticated request body, before anything has proved
the caller owns the address:

```ts
if (!existingAccount && !existingStudent) {
  await prisma.student.create({
    data: { firstName, lastName, email, claimedAt: new Date(), account: { create: { email } } },
  });
}
```

`firstName`/`lastName` come straight from the body and `claimedAt` is stamped
as though the person had registered themselves. Rate limits (5/hour per IP,
3/15min per address) bound the volume; they do not change the shape.

The invariant this restores is the one #385 established for teachers: **no
rows before the address is verified.**

## What the issue got wrong

Four corrections, measured against the code as of `8b250f55`.

### 1. The enum needs two new members, not one

The issue's change table says "`MagicLinkPurpose` gains `student_signup` —
one enum member; #385 creates the enum with room for it".

Measured (`prisma/schema.prisma:116-120`), the enum has three members:
`sign_in`, `teacher_signup`, `teacher_profile_pending`. The signup *ticket*
carries its own purpose, distinct from the emailed link's. A faithful port
therefore needs **two** members — `student_signup` for the link and
`student_profile_pending` for the ticket — unless the ticket purpose is
deliberately shared between families. It is not; see *Decision 1*.

### 2. The redirect does not belong in the ticket

The issue requires `magic-link/verify` to "carry `redirectTo` through to the
ticket" and calls for `signup-ticket.ts` to be "generalised" because it
"assumes one purpose and no redirect".

The purpose half is right. The redirect half is not.
`magic-link/verify/route.ts` already returns `redirectTo` in its response
body, and `verify/page.tsx` navigates on it. The browser then sits *on* the
booking page, whose own URL carries the destination. Nothing later in the
flow reads a destination back out of the ticket.

What actually changes is one expression in `verify`: the signup branch
returns the token's redirect instead of the hardcoded `'/signup/profile'`.
`signup-ticket.ts` is generalised for **family**, and for nothing else.

### 3. The named e2e specs are the wrong three

The issue names `booking.spec.ts`, `student-journey.spec.ts` and
`invitations.spec.ts`. Re-derive with:

```bash
grep -rn "First name\|Last name" tests/e2e/ src/components/booking/
grep -rn "First time here?\|Send me the link" tests/e2e/
```

| File | Measured | Verdict |
|---|---|---|
| `booking.spec.ts:158-159` | asserts `'First time here?'` and `'Send me the link'` only | survives |
| `student-journey.spec.ts` | seeds students via Prisma; never drives signup | survives |
| `invitations.spec.ts` | names the route in a comment at :71; its `First name` fills (131, 193) are the CRM contact form | survives |
| `magic-link-handoff.spec.ts:287-288` | **fills `First name`/`Last name` in the booking form** | **breaks** |
| `passkey.spec.ts:149` | heading text only | survives |
| `account-hybrid.spec.ts:160` | heading text only | survives |

None of the three named specs requires an edit; the one that does was not
named. The issue's set is the flows that *conceptually* involve student
signup; the breaking set is the assertions that *type into the form*, and
the two do not coincide because #385's shape keeps "First time here?" as the
panel title.

Two tiers the issue omits entirely:

- component — `src/components/booking/booking-sign-in.test.tsx`
- integration — `tests/integration/signup-api.test.ts` (its first case,
  "creates account + claimed student for a fresh email", **inverts**),
  `auth-email-case.test.ts:20,64`, `magic-link-origin-binding.test.ts:10`

### 4. The uncorrectable-name argument is stale

The issue argues its harm exceeds #382's because a squatted student
"inherit[s] a name they did not choose **and cannot change**", quoting
`notifications-form.tsx`'s docblock on the missing inputs.

#400 closed on 2026-09-02 and shipped `src/components/student/name-form.tsx`.
A student can correct their own name at `/account`. The defect stands — a
public route still writes two rows from unverified input, and the real owner
still meets a name a stranger picked — but its severity is ordinary, not
special.

## What the issue got right

- The create is where and what it says it is (its line numbers, 42-52, are
  off by one; the block is 41-51).
- `POST /api/account/student-profile` does require a session **and** a
  teacher profile, answering `NO_PROFILE_SOURCE` (`route.ts:24-29`) and
  copying the names off the `Teacher`.
- **The unclaimed-CRM path needs no special handling.** `resolveOrClaimAccount`
  (`src/lib/auth/account.ts:49-64`) claims such a row at verification and
  returns non-null, so verify's `!resolved` ticket branch cannot fire for it.
  That address takes the ordinary sign-in path with the teacher's contact
  name intact.
- Collecting the name on the booking page, rather than on a dedicated
  page mirroring the teacher's `/signup/profile`, is the right shape. A
  student is trying to reserve a mat; a screen between them and that is a
  real cost.

## What nothing had noticed

### The verify screen tells students to set up a page they will never have

`verify/page.tsx` renders `isNewSignup` — computed as the absence of
`accountId` in the response — as "Email confirmed / **Let's set up your
page.**". That is teacher copy. A student ticket takes the same branch,
because it is the same "ticket, not session" response shape. Fixed here,
since this branch is what makes that string reachable for students.

### The student ticket, unlike the teacher's, can be minted with nowhere to go

`/signup/profile` exists unconditionally, so a teacher ticket always has a
home. The student ticket's home is a caller-supplied URL, and `redirect` is
optional in `studentSignupSchema` (`src/lib/schemas.ts:132`). "Mint a
ticket" and "have somewhere to spend it" are two facts that can come apart.
See *Decision 2*.

### `JoinAsStudent` POSTs with no body at all

`src/components/booking/join-as-student.tsx` calls
`fetch('/api/account/student-profile', { method: 'POST' })` — no body, no
`Content-Type`. `parseBody` (`src/lib/api-utils.ts:55-60`) opens with
`await request.json()`, which throws on an empty body and returns
`400 Invalid JSON`. Adding an unconditional body parse to that route breaks
a shipped path. See *§6*.

## Decisions

### Decision 1 — the ticket is scoped per family

Two new enum members. `mintSignupTicket`, `peekSignupTicket` and
`consumeSignupTicket` each take a `SignupFamily` and check the token's
purpose against it.

Not privilege escalation either way — the ticket holder owns the address and
could have gone to `/signup` and signed up as a teacher regardless. What the
scoping buys is that each family's bearer credential cannot act in the other:
a ticket minted because someone clicked a link to book a yoga class cannot
create a public teacher page. It also gives `consumeSignupTicket`'s existing
purpose-mismatch `log.warn` — unreachable until now, since only one purpose
existed — something real to catch.

Rejected: one shared `profile_pending` purpose. Fewer members and less
plumbing, but it makes the booking flow a door into teacher-account creation
and needs a data migration renaming the value on existing rows.

### Decision 2 — no redirect, no ticket

`student-signup` mints a `student_signup` (ticket-producing) token only when
the address has no account **and** a redirect was supplied. Otherwise it
mints a plain `sign_in` token, which for a fresh address dead-ends at
verify's existing `Account not found` 400 — exactly as `magic-link/send`
already behaves for an unknown address.

`magic-link/verify` enforces the same thing independently: it computes the
destination first and mints only if there is one, so a `student_signup`
token whose stored redirect fails `isSafeRelativePath` produces a 400 rather
than an unspendable ticket. Two doors, both closed, so neither a crafted
request nor a later refactor can strand a verified student with a credential
and no page to spend it on.

`BookingSignIn` always supplies a redirect, so the happy path is unchanged,
as is the route's uniform 200.

Rejected: making `redirect` required in the schema (a 400 on a public route
where a uniform 200 is otherwise the contract, and it breaks the shape three
integration tests use); and minting unconditionally and accepting the
stranded state.

### Decision 3 — the name form is a fourth branch on the booking page

`page.tsx` already ends in a three-way choice — `viewer` (student session),
`guestTeacher` (teacher session, no student side), else `BookingSignIn`. A
ticket branch joins it. The form POSTs to `/api/account/student-profile`,
which creates the rows and mints a session; `router.refresh()` then
re-renders the same page into the normal `BookingFlow`.

Rejected: merging the name into `BookingFlow`. It is built entirely around
an existing `studentId` — `handleBook` PUTs to `/api/students/${studentId}`
to persist a changed tier — so it would need a null-id mode, a
profile-create call, and the new id threaded from that response into the
booking call. Two authorization modes inside the component that takes
bookings, to save one render.

### Decision 4 — the verify copy is fixed here, not filed

One branch beside `destinationCopy`, keyed on the same value it is.

## Neither privacy nor tier selection is bypassed

Both were raised as a risk against Decision 3. Neither is part of signup, so
neither can be skipped by moving what signup writes.

**Tier.** `tierSelectedAt` is never written at signup. It is stamped
server-side by the booking routes on a self-booking
(`api/registrations/route.ts:192-197`, `api/waitlist/route.ts:33-34`) or by
an explicit tier edit (`api/students/[id]/route.ts:88`). The picker appears
because `page.tsx` passes `isFirstBooking={viewer.tierSelectedAt === null}`.
Today's pre-verification create leaves `incomeTier` unset (schema
`@default(3)`) and `tierSelectedAt` null; `student-profile`'s create sets
`incomeTier: DEFAULT_INCOME_TIER`, which is 3, and leaves `tierSelectedAt`
unset. Same resulting state, so the picker fires either way.

**Privacy.** No `StudentPrivacy` row is created by signup or by booking.
Its two writers are the student's own route
(`api/students/[id]/privacy/route.ts`, an upsert on save) and unlink
(`services/invitations.ts`). Scope comes from `TeacherStudent`, which a
self-booking upserts (`api/registrations/route.ts`, inside `!isTeacher` so a
roster add or walk-in cannot launder itself into consent). The absence of a
row *is* maximum privacy and is rendered as such — `/account/privacy` hands
its `MAX_PRIVACY` constant to any linked teacher with no row, and readers
agree (`lib/student-visibility.ts`, `flags?.shareFullName ?? false`). The
default a teacher sees is `formatStudentName(first, last, false)`, first name
plus a lowercased last initial.

**The one bypass, and why it constrains this change.**
`lib/student-visibility.ts`'s `bypassesPrivacy` returns true for a `Student`
whose `claimedAt` is null, disabling every flag and logging a warning. That
exists for teacher-typed CRM contacts, where there is nothing to protect. It
makes `claimedAt` a privacy control, not bookkeeping.

### The create's column census

The new create must reproduce today's resulting row exactly. Two columns
carry a silent failure that no type catches:

| Column | Value | Consequence if wrong |
|---|---|---|
| `claimedAt` | `new Date()` | null ⇒ `bypassesPrivacy` hands the teacher the full name, email, phone and address the student never shared |
| `tierSelectedAt` | left unset | stamped ⇒ the tier picker never shows; billed at tier 3 indefinitely, never having chosen |
| `incomeTier` | `DEFAULT_INCOME_TIER` | matches the schema default the old create relied on |
| everything else | left unset | `reminderPref`, `emailNotifications` take schema defaults; `phone`/`birthday`/`address` stay null |

Both hazard rows get an explicit assertion.

## Design

### 1. Schema

`MagicLinkPurpose` gains `student_signup` and `student_profile_pending`.
Generated by `npx prisma migrate dev`; no hand-authored SQL. Postgres 16
(`docker-compose.yml`) permits `ALTER TYPE … ADD VALUE` inside a transaction
provided the new value is not used in the same transaction, which it is not.

### 2. `src/lib/auth/signup-ticket.ts`

```ts
export type SignupFamily = 'teacher' | 'student';

const TICKET_PURPOSE = {
  teacher: 'teacher_profile_pending',
  student: 'student_profile_pending',
} as const satisfies Record<SignupFamily, MagicLinkPurpose>;
```

`mintSignupTicket(db, email, family)`, `peekSignupTicket(db, token, family)`
and `consumeSignupTicket(db, token, family)` all gain the parameter and
compare against `TICKET_PURPOSE[family]`. The `satisfies` is the tether: a
third family cannot be added without a purpose for it.

Callers pass the family they are; none infers it from the token. A token of
the wrong family is rejected — and, in `consume`'s case, is destroyed first,
because `verifyMagicLinkToken` deletes atomically before returning anything
to compare. That ordering is unchanged from #385 and is documented there;
this spec does not alter it.

The cookie name stays shared. Purpose is what separates the families.

### 3. `POST /api/auth/student-signup`

- `studentSignupSchema` drops `firstName`/`lastName` and gains `.strict()`,
  matching `teacherSignupSchema`. Strict so a stale caller still sending
  names fails loudly rather than having them silently ignored.
- Both existence reads and the entire create block are deleted, including
  the P2002 race handling, which exists only because of the create. The
  `Prisma` and `isUniqueConflictOn` imports go with it.
- One `Account` lookup, mirroring `teacher-signup`:

  ```ts
  const existing = await prisma.account.findUnique({ where: { email } });
  const purpose = !existing && redirect ? 'student_signup' : 'sign_in';
  ```

  The `Student` lookup is not replaced: an unclaimed CRM row is claimed at
  verification, so it never needed a branch here.
- The uniform 200, the origin nonce, and the `try`/`catch` that keeps a
  delivery failure from discarding the nonce cookie are all unchanged.

### 4. `POST /api/auth/magic-link/verify`

Destination first, mint second:

```ts
const signupDest =
  purpose === 'teacher_signup'
    ? '/signup/profile'
    : purpose === 'student_signup' && tokenRedirect && isSafeRelativePath(tokenRedirect)
      ? tokenRedirect
      : null;

if (!resolved && signupDest) {
  const family = purpose === 'teacher_signup' ? 'teacher' : 'student';
  const ticket = await mintSignupTicket(prisma, email, family);
  const response = respondOk({ redirectTo: signupDest });
  setSignupTicketCookie(response.headers, ticket);
  clearOriginNonceCookie(response.headers);
  return response;
}
```

A `student_signup` token with an unusable redirect falls through to the
existing `Account not found` 400. The response still omits `accountId`,
which is what the client reads as "no session was created".

### 5. `src/app/(public)/verify/page.tsx`

A headline branch beside `destinationCopy`, keyed on the destination:
`'/signup/profile'` keeps "Let's set up your page."; anything else (in
practice a `/book/` path) reads "Let's finish your booking."
`destinationCopy` already answers `/book/` with "Taking you back to your
class now." and needs no change.

### 6. `POST /api/account/student-profile`

Gains `teacher-profile`'s `Authorization` discriminated union. Control flow:

```ts
const ticketToken = request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
// The cookie is READ, not consumed, so this ordering still parses the body
// before spending a single-use ticket. It also keeps the session path — a
// body-less POST from JoinAsStudent — away from parseBody's request.json().
let names: { firstName: string; lastName: string } | null = null;
if (ticketToken) {
  const parsed = await parseBody(request, studentProfileSchema);
  if ('error' in parsed) return parsed.error;
  names = parsed.data;
}
const ticketEmail = ticketToken
  ? await consumeSignupTicket(prisma, ticketToken, 'student')
  : null;
```

- `studentProfileSchema` is `z.object({ firstName: z.string().min(1),
  lastName: z.string().min(1) }).strict()` — required, not optional, because
  it is parsed only where it applies.
- Ticket path: creates `Student` + `Account` per the column census, mints a
  session, clears the ticket cookie.
- Session path: unchanged, including `ALREADY_STUDENT`, `NO_PROFILE_SOURCE`,
  the unclaimed-row claim, and the two-key P2002 handling.
- A ticket whose family is `teacher` is consumed, found to be the wrong
  purpose, logged and discarded — `verifyMagicLinkToken` deletes atomically
  before there is anything to compare, which is #385's ordering and is not
  changed here. `ticketEmail` is then null, so the request falls through to
  the session path and 401s when there is no session; the already-parsed
  body is discarded. Not reachable through the UI: a teacher mid-signup
  reaching a booking page gets `peekSignupTicket(..., 'student')`, which
  returns null without consuming anything, and is rendered `BookingSignIn`.

### 7. `src/app/(public)/[slug]/book/[classId]/page.tsx`

A fourth branch: `viewer → guestTeacher → ticket → BookingSignIn`. The
cookie is read only when there is no session at all, so an ordinary
anonymous render costs no extra query:

```ts
// `session` is already read above, for the viewer/guestTeacher branches.
const ticketToken = session ? undefined : (await cookies()).get(SIGNUP_TICKET_COOKIE)?.value;
const ticketEmail = ticketToken
  ? await peekSignupTicket(prisma, ticketToken, 'student')
  : null;
```

`peek`, not `consume` — the profile route is the only thing that spends the
ticket, so reloading the page costs nothing. Same choice `/signup/profile`
makes.

### 8. New component: the name step

A `'use client'` form with first and last name, posting to
`/api/account/student-profile` and calling `router.refresh()` on 201.
Follows `ProfileSetupForm`'s shape and `JoinAsStudent`'s error handling
(`readErrorMessage`, a `role="alert"` line, no forever-disabled button).

### 9. `src/components/booking/booking-sign-in.tsx`

The `firstName`/`lastName` state and inputs go, as does the `mode === 'new'`
block wrapping them. The intro copy loses "We create your account" — nothing
is created at that point any more. `'First time here?'` and
`'Send me the link'` stay; three e2e specs assert them.

## Tests

Unit:

- family scoping — a `teacher` ticket is refused by `peek`/`consume` under
  `student` and vice versa

Integration:

- `student-signup` writes no `Student` and no `Account` for a fresh address
  (the inverted case in `signup-api.test.ts`)
- purpose selection: fresh + redirect ⇒ `student_signup`; fresh, no
  redirect ⇒ `sign_in`; existing account ⇒ `sign_in`
- verify of a `student_signup` token returns the booking redirect, sets a
  ticket cookie, and omits `accountId`
- an unclaimed CRM address still claims at verify and gets a session, with
  the teacher's contact name intact and no ticket
- `student-profile` under a ticket creates the row with `claimedAt` stamped
  and `tierSelectedAt` null — the two census hazards, asserted directly
- `student-profile` under a ticket with a malformed body 400s **and leaves
  the ticket live**
- a `teacher_profile_pending` ticket presented to `student-profile` does not
  create a student

Component:

- `booking-sign-in.test.tsx` — the name inputs are gone
- the name step — submits, and surfaces an error without disabling forever

E2E:

- `magic-link-handoff.spec.ts:287-288` updated to the email-only form
- one full-path spec in `booking.spec.ts`: email → verify → name → tier
  picker → booked

## Not this issue

- The student-facing name input — #400, closed 2026-09-02.
- #382 and #385 are the teacher half and are unaffected.
- Binding a magic link to the requesting device is #214.
- The teacher families' ticket and profile routes change only by gaining the
  family argument; their behaviour is unaffected.
