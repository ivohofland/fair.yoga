# One lowercase invariant for every email column, stated in two places

**Issue:** #170 — Emails are normalized on write only in the two tables #166
added — everywhere else `Foo@x.com` and `foo@x.com` are different people
**Spun out of:** #166 / PR #169
**Date:** 2026-08-07

## The problem, stated after measuring it

A person who signs up as `foo@x.com` and later types `Foo@x.com` cannot sign in,
and is not told so. Both lookups in `POST /api/auth/magic-link/send` use the raw
string; a miss falls into the deliberate anti-enumeration branch, so they get the
same reassuring *"If an account exists, a magic link has been sent"* as someone
who typed it correctly, and no mail is ever sent. There is no other way in:
passkey authentication has the same shape, and so does `resolveOrClaimAccount`.

The signup path is worse than a lockout. `POST /api/auth/student-signup` and
`POST /api/teachers` both gate on `account.findUnique({ where: { email } })` with
the raw string. A capital letter walks past that gate *and* past the unique
index, producing a second `Account` for the same human — at which point their
bookings, notifications and payments are split across two identities with no
merge path.

#166 normalised the two columns it added (`Invitation`, `TeacherBlock`) and said
in as many words that it was scoping itself there. This is that filing.

## What was measured

### The database compares case-sensitively, in both environments

```
                       ethical_yoga      ethical_yoga_test
datcollate             en_US.utf8        en_US.utf8
'a@x.com' = 'A@x.com'  false             false
```

No `citext`, no ICU collation, no `COLLATE` clause — `grep -rn "citext\|COLLATE\|collation" prisma/` returns nothing. The unique keys on `Account.email`,
`Teacher.email` and `Student.email` are plain btree over the raw column, so
`Foo@x.com` and `foo@x.com` are two distinct keys and can both exist.

### Six models carry an email column; four are in scope

`Account`, `Teacher`, `Student`, `MagicLinkToken` are unnormalised and in scope.
`Invitation` and `TeacherBlock` already hold the invariant under
`20260805074500_invitation_check_constraints` and are not touched.
(`Notification.emailSent` is a boolean, not an address.)

### Nothing non-lowercase exists in either database

| table | dev rows | test rows | rows where `email <> lower(email)` |
|---|---|---|---|
| `Account` | 711 | 10,636 | **0** |
| `Teacher` | 3 | 6 | **0** |
| `Student` | 10 | 4 | **0** |
| `MagicLinkToken` | 0 | 0 | **0** |

The backfill is therefore a measured no-op on both environments, and no collision
can exist to resolve.

### Every generated test address is lowercase

The CHECK constraints cannot turn the suite red. Every dynamically built test
email interpolates one of `Date.now()` (digits) or
`crypto.randomBytes(n).toString('hex')` (lowercase hex) into a lowercase literal
prefix. The only two mixed-case email literals in the tree are
`invitation-constraints.test.ts:62` and `:93`, which exist to prove the
*existing* `Invitation`/`TeacherBlock` CHECK constraints reject uppercase — they
target tables this change does not touch.

`gdpr.ts` writes five synthesized addresses of the form
`deleted-${id}@deleted.invalid`. Every one of those ids is `@default(uuid())`,
which is lowercase hex, so they satisfy a lowercase CHECK. `prisma/seed.ts`'s
address literals are all lowercase.

### The compensation census re-derives exactly

`grep -rn "toLowerCase" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\."`
returns **16** lines. One is the word inside a comment (`gdpr.ts:63`); two are
unrelated to email (`profile-form.tsx:175` slugifies `pageSlug`,
`format.ts:12` lowercases a last initial). 16 − 1 − 2 = **13** sites that exist
only because of this defect:

*Write-side normalisation into the two #166 columns — 2:*

| site | function |
|---|---|
| `src/services/invitations.ts:176` | `inviteContact` |
| `src/app/api/invitations/[id]/route.ts:100` | `PUT /api/invitations/[id]` |

*Read-side compensation — lowering an `Account`/`Student` address before
comparing it with `Invitation.email` / `TeacherBlock.email` — 9:*

| site | function |
|---|---|
| `src/services/invitations.ts:366` | `notifyInvitee` |
| `src/services/invitations.ts:447` | `listPendingInvitations` |
| `src/services/invitations.ts:530` | `acceptInvitation` |
| `src/services/invitations.ts:636` | `declineInvitation` |
| `src/services/invitations.ts:791` | `unlinkTeacher` |
| `src/services/link-consent.ts:63` | `resolveInvitationOnLink` |
| `src/services/gdpr.ts:69` | `exportStudentData` |
| `src/services/gdpr.ts:414` | `deleteStudentAccount` |
| `src/app/api/students/route.ts:164` | the `deliverInvitation` call |

*Rate-limit bucket keys, so two casings share one throttle — 2:*
`src/app/api/auth/magic-link/send/route.ts:29`,
`src/app/api/auth/student-signup/route.ts:29`.

2 + 9 + 2 = 13. ✓

Two further sites compensate in a second style — `mode: 'insensitive'` equality
against `Student.email`, both in `invitations.ts`: `:111` (`hasRosterLink`) and
`:383` (`notifyInvitee`). `grep -rn "insensitive"` returns 11 non-test lines, of
which 5 are `contains` search filters (students, rooms), 4 are comments, and
these 2 are equality matches. 5 + 4 + 2 = 11. ✓

**15 sites in total.**

### Account creation is downstream of the magic-link token

```
POST /api/auth/magic-link/send  (body email, Zod-parsed)
  → generateMagicLinkToken(prisma, email)   → MagicLinkToken.email
  → GET /api/auth/magic-link/verify         → verifyMagicLinkToken → email
  → resolveOrClaimAccount(prisma, email)    → Account.create({ data: { email } })
```

The email reaching `src/lib/auth/account.ts:47` never comes from a request body
— it comes from the stored token. Normalising `magicLinkSendSchema.email`
therefore propagates all the way to `Account.create` without `account.ts` being
touched at all.

## Corrections to the issue's premise

**1. The blocker in acceptance criterion 1 is false, and it is the load-bearing
one.** The issue states that normalising in `src/lib/schemas.ts` via
`.transform()` is *"blocked"* because a transform hides the schema's `.shape`
from the server-owned-field walk in `schemas.test.ts`, and instructs "Pick a
choke point that survives that."

Probed against the installed Zod (4.4.3) rather than reasoned about:

| | parent `.shape` | keys the register reads | normalises |
|---|---|---|---|
| **field-level** `.transform()` | **defined** | `['email','name']` | yes |
| **object-level** `.transform()` | `undefined` | — | — |

Only an object-level transform — one wrapping the whole `z.object({...})` —
removes `.shape`. A field-level transform leaves the register fully able to walk
the schema. The comment this claim came from, at `invitations.ts:164-167`, says
"a `.transform()` there" without distinguishing the two, and #170 inherited the
imprecision. **The obvious fix was available all along.** That comment is
corrected by this work, not merely relocated.

**2. "Every `email` line in `src/lib/schemas.ts` (8 of them)" is 6.**
`grep -c "z\.string()\.email()" src/lib/schemas.ts` → **6**, at lines 44, 51, 64,
97, 137, 148. The issue counted 8 lines *containing the word* `email`; two of
those are a prose comment (`:132`) and the `emailNotifications` boolean (`:174`),
neither of which is an address field.

**3. The ingress list of five is missing five more, all in `gdpr.ts`.** Erasure
writes synthesized addresses at `:416`, `:447`, `:489`, `:817` and `:828`,
bypassing Zod entirely. They are safe under a lowercase CHECK (uuid is lowercase
hex, measured), but an unnamed writer is exactly how a CHECK constraint breaks
something, so they are named here.

**4. The collision scenario the migration was told to plan for does not exist,
and it could not "die half-way" if it did.** Criterion 2 warns that "two
accounts differing only in case may already exist" and that "a migration that
assumes no collision and dies half-way is worse than none."

Both halves measured. Zero non-lowercase rows across all four tables in both
databases, and fair.yoga is pre-launch with no production data — so no collision
exists to resolve. And half-application is not a failure mode available to this
migration: **Prisma 6.19.3 runs each migration file in a transaction.** Verified
by applying a deliberately-colliding two-statement migration to a scratch
database and confirming its first statement left no row behind
(`probe_marker rows: 0`).

The backfill is kept — `ADD CONSTRAINT ... CHECK` validates pre-existing rows,
also measured — but the collision guard the issue asks for is not built. See
Decisions.

**5. Every line number in the issue is stale.** PR #179 (#174) shifted
`invitations.ts` by up to 101 lines and `gdpr.ts` by up to 116. The issue's
`:507` is now `:530`, its `:690` is now `:791`, its `:298` is now `:414`. The
*sites* are all correct and the counts re-derive; only the coordinates moved. The
table above carries the current ones, keyed by function name so the next drift
does not matter.

## Decisions taken

### Where the choke point lives: a shared Zod primitive, with CHECK as the backstop

The invariant is stated in exactly two places and nowhere else:

1. **`emailField` in `src/lib/schemas.ts`** normalises at HTTP ingress.
2. **Four CHECK constraints** reject anything that reaches storage by another
   route.

Rejected: a per-schema inline transform (the rule would live in six places, and
a seventh schema silently opts out); and a `BEFORE INSERT OR UPDATE` trigger
that lowercases on write. The trigger is genuinely unbypassable, but it
*silently rewrites* rather than failing, which is the unobservable-degradation
shape this project has an open issue about (#157), and it hides the invariant
from TypeScript entirely.

**What this split does and does not guarantee, stated precisely:** the primitive
normalises HTTP ingress *only*. `prisma/seed.ts`, `gdpr.ts`'s five anonymisation
writes, test fixtures and raw SQL bypass Zod — they are not normalised, they are
**rejected**. The *guarantee* is complete: nothing non-lowercase can be stored.
The *normalisation* is not universal, deliberately, because a writer that
bypasses the schema layer should fail loudly rather than be quietly corrected.

### The migration backfills, and does not guard against collisions

Two separate calls, and only the first survived measurement.

**The backfill stays.** `ALTER TABLE ... ADD CONSTRAINT ... CHECK` validates rows
that already exist — `check constraint "…" of relation "…" is violated by some
row` — so on any database holding one mixed-case address, the constraint fails
without it. Re-seeding is not the alternative it looks like: a migration is the
artifact that ships, it runs on contributors' databases nobody here can measure,
and `db:reset` would destroy their work while being a step they have no reason to
know about. Four lines, provably inert today, correct elsewhere.

**The collision pre-check does not get built.** An earlier draft of this spec
guarded the backfill with a `DO $$ … RAISE EXCEPTION` block, on the issue's
reasoning that a migration which "dies half-way is worse than none." Both of its
justifications are false, measured:

- **It cannot die half-way.** Prisma 6.19.3 wraps each migration in a
  transaction; a colliding statement rolls the whole file back.
- **Its error would be worse than the one it replaced.** Postgres reports
  `DETAIL: Key (email)=(foo@x.com) already exists.` — naming the offending
  address. The custom `RAISE EXCEPTION` could only report a count.

Thirty lines removed for a strictly better diagnostic. `MagicLinkToken` cannot
collide regardless: its `email` column carries no unique index.

### All 13 compensations come out, including the two write-side ones

The issue proposes keeping `inviteContact`'s and `PUT /api/invitations/[id]`'s
`.toLowerCase()` as defence in depth, on the grounds that they normalise a third
party's address rather than an authenticated one. Rejected: under the shared
primitive they are unfalsifiable no-ops, and a future reader will read them as
load-bearing. `Invitation` has held a CHECK constraint since #166, so a caller
reaching `inviteContact` outside the HTTP path hits a loud constraint violation
instead of silently working — which is the outcome this project prefers, and
which a surviving `.toLowerCase()` would suppress.

## Design

### `src/lib/schemas.ts`

```ts
// Module-private, beside `isoDate` and `timeHHmm` in the shared-validators
// section — NOT exported. `schemas.test.ts`'s server-owned-field walk requires
// every exported `ZodType` to have a readable `.shape`, and a field primitive
// has none. Nothing outside this file validates an email, so the export buys
// nothing; the three existing shared validators are private for the same reason.
const emailField = z.string().email().transform((s) => s.toLowerCase());
```

Adopted at all six address fields:

| line | schema | route | writes to |
|---|---|---|---|
| 44 | `magicLinkSendSchema` | `POST /api/auth/magic-link/send` | `MagicLinkToken` → `Account` |
| 51 | `studentSignupSchema` | `POST /api/auth/student-signup` | `Student` + `Account` |
| 64 | `passkeyAuthOptionsSchema` | `POST /api/auth/passkey/authenticate/options` | lookup only |
| 97 | `createTeacherSchema` | `POST /api/teachers` | `Teacher` + `Account` |
| 137 | `createInvitationSchema` | `POST /api/students` | `Invitation` |
| 148 | `updateInvitationSchema` | `PUT /api/invitations/[id]` | `Invitation` |

`passkeyAuthOptionsSchema` matters as much as the writers: it is a *lookup*, and
lowercasing it is what makes the lookup find the now-lowercase account.

**A type risk to measure, not assume.** `create-student-form.tsx:30` and
`contact-form.tsx:19` derive their wire types via
`z.infer<typeof createInvitationSchema>` and `z.infer<typeof updateInvitationSchema>`
— these are the #136/#81 form-field pins. `z.infer` is the **output** type, and a
transform makes input and output diverge in general. For a `string → string`
transform both should remain `string`, leaving the pins unaffected. The plan
compiles this and records the result rather than the spec asserting it. If they
do diverge, those two components need `z.input`, and that is a latent defect this
change exposes rather than creates.

### The migration

Hand-authored (Prisma cannot express CHECK), following
`prisma/migrations/20260805074500_invitation_check_constraints/` for both
structure and the explanatory-docblock style. Two parts, in this order:

1. `UPDATE "<table>" SET email = lower(email) WHERE email <> lower(email)` for
   `Account`, `Teacher`, `Student`, `MagicLinkToken`. A measured no-op here;
   required because part 2 validates pre-existing rows, and present because the
   migration must be correct on an environment nobody has measured.
2. `CHECK (email = lower(email))` on the same four tables, named
   `<Table>_email_lowercase_check` to match the #166 pair.

Nothing else. The collision guard is deliberately absent — see "The migration
backfills, and does not guard against collisions" above for the two measurements
that removed it.

### The 15 sites

The 13 `.toLowerCase()` calls in the census table are deleted. The 2
`mode: 'insensitive'` equality lookups revert to `findUnique` on the unique
index — a performance repair, not tidying: `invitations.ts:99` currently
documents that the insensitive match *cannot use the unique index* and accepts a
scan of `Student` in exchange.

### Guards, and proving each one bites

Per guard, the plan carries an explicit break-record-restore step.

| guard | how it is broken | what must be recorded |
|---|---|---|
| the schema pin (a test walking `schemas.ts` asserting every address field maps `'A@X.com'` → `'a@x.com'`) | revert one field to bare `z.string().email()` | the verbatim failure, naming that schema |
| each of the 4 CHECK constraints | attempt an uppercase insert | the verbatim Postgres error |
| each of the 4 CHECK constraints | drop the constraint, retry the insert | that it now succeeds — proving the test tested the constraint |
| the sign-in regression test | revert `magicLinkSendSchema` to bare | that it fails, i.e. it could detect the bug |

### Comments that currently say something untrue

Per the rule that a claim is corrected in every artifact, not just the nearest:

- `src/services/invitations.ts:164-167` — "a `.transform()` there would hide the
  schema's `.shape`". Wrong for field-level transforms; this is the sentence that
  misled #170. Corrected, not relocated.
- `src/services/invitations.ts:169-172` — "Account and Student emails are stored
  as typed … a systemic, pre-existing bug, filed separately". The filing is now
  closed; the sentence must stop describing a live defect.
- `src/services/invitations.ts:91`, `:99`, `:351`, `:377` — four comments
  explaining why the lookups are case-insensitive, on lookups that no longer are.
- `src/services/gdpr.ts:64-65` and `:396-397` — both assert "`Student.email` is
  stored exactly as typed", which becomes false.
- `docs/data-model.md` — the lowercase invariant is documented for `Invitation`
  and `TeacherBlock`; it now covers four more tables.
- Issue #170 itself — a comment recording that its criterion-1 blocker was false.

### Task order is load-bearing

1. `emailField` + schema adoption + the schema pin + the two regression tests.
2. The migration. The CHECK constraints can only land *after* normalisation, or
   a test posting mixed case 500s instead of passing.
3. Compensation removal — safe only once 1 and 2 both hold.
4. Comment and doc corrections.

This ordering is restated in each dispatch, not only here.

### Suites that run

`integration` is never run in full (one file in it is IP rate-limited and a
whole-project run trips it). The plan names the files that run by path:
`tests/integration/invitation-constraints.test.ts`,
`tests/integration/students-api.test.ts`,
`tests/integration/invitations-api.test.ts`,
`tests/integration/account-api.test.ts`, plus `src/lib/schemas.test.ts`,
`src/lib/auth/session.test.ts`, `src/services/invitations.*.test.ts`,
`src/services/gdpr.test.ts` and `src/services/link-consent`-adjacent tests, and
a new migration-constraint test file.

## Acceptance

1. `emailField` exists in `src/lib/schemas.ts` and is the only place an address
   is normalised in application code. All six schemas use it.
2. A test creates an account as `foo@x.com`, calls
   `POST /api/auth/magic-link/send` with `Foo@x.com`, and asserts a
   `MagicLinkToken` row was issued. It fails before the change.
3. A test calls `POST /api/auth/student-signup` with `Foo@x.com` when
   `foo@x.com` already exists, and asserts no second `Account` row. It fails
   before the change.
4. A test calls the passkey options route with `Foo@x.com` and asserts the
   account's credential ids come back.
5. Four `<Table>_email_lowercase_check` constraints exist, each with a test that
   records the verbatim rejection *and* the verbatim success after the
   constraint is dropped.
6. `grep -rn "toLowerCase" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\."`
   returns exactly 4 lines: `emailField` itself, the `gdpr.ts` comment,
   `profile-form.tsx`'s `pageSlug`, and `format.ts`'s last initial. **17 − 13 =
   4** — 17, not the 16 measured above, because adding the primitive adds a
   `toLowerCase` of its own. The pre-implementation census and the
   post-implementation acceptance count are one apart by construction.
7. `mode: 'insensitive'` no longer appears as an *equality* match anywhere;
   `hasRosterLink` is a `findUnique`.
8. Every comment in "Comments that currently say something untrue" is corrected,
   and #170 carries the criterion-1 correction.

## What this does not do

- **It does not make email handling RFC-correct.** RFC 5321 permits the local
  part to be case-sensitive (the domain definitionally is not), so lowercasing is
  technically lossy. No real provider honours that distinction, but this is an
  assumption, not a fact, and it is stated rather than smuggled.
- **A user who types `Ivo@Example.com` will see `ivo@example.com` echoed back.**
  Accepted.
- **It does not touch `Invitation` or `TeacherBlock`**, which already hold the
  invariant.
- **It does not add an email-change flow.** `prisma/schema.prisma:112-115`
  records that there deliberately is none — and that adding one "must update the
  account and its live linked profiles together, through a single choke point."
  This change does not create one, and the primitive it adds is the natural
  place for one to normalise when it lands.
- **It does not fix the unclaimed-CRM-student shadowing edge** noted at
  `src/app/api/teachers/route.ts:27-30` — pre-existing, unrelated to case, and
  already tracked in that comment as follow-up work.
- **It does not add rate limiting anywhere.** #168 tracks the rate limiter's own
  defects.

## Ratio

Predicted: **2–3 spin-outs, expected to be leaves rather than decisions.** The
base rate on this tracker is 3–4 (#86 was 8; #166 was 5; #140 was 1). #170 sits
low on every factor the roadmap credits for a low ratio: no new domain, no new
tables, no new user-facing surface, no downstream product call, and a net
deletion of code. The factor pushing the other way is real — this is the auth
path, which has had less adversarial review than the class, template and payment
surfaces that dominate this backlog, and removing 15 compensations is 15
invitations to ask whether the surrounding function is correct.

Named in advance, so each fold/file call is made deliberately:

1. `z.infer` vs `z.input` on the two form components — expected to fold.
2. Something in `gdpr.ts`'s erasure path — five email writers, and #171 came from
   there.
3. The `teachers/route.ts` shadowing edge — should attach to its existing
   tracking, not be filed fresh; pre-existing debt this makes visible, not worse.
4. Rate-limiter observations — attach to #168.

The floor overrides all of it: a defect a real user hits is fixed or filed
regardless of what that does to the count.
