# Account Hybrid — one login, two hats

**Date:** 2026-07-20 · **Status:** approved (design discussed and accepted in session)

## Problem

A person is one human but the system sees two: `Teacher` and `Student` are
separate identities keyed by their own unique emails. Consequences today:

- A teacher cannot attend another teacher's class with their own email — the
  booking page shows them a sign-in form forever (dead end).
- Magic-link verify resolves teacher-first: if an email ever exists in both
  tables, the student half is unreachable by email link.
- The public teacher-signup endpoint only checks the Teacher table, so a
  student's email can become a teacher **today**, silently locking that
  student out of their bookings (live footgun).
- A student who becomes a teacher (or vice versa) needs a second email and
  loses continuity: separate passkeys, separate sessions.

## Decision

**Hybrid model: auth unifies, domain doesn't.** A small `Account` table owns
authentication (email identity, passkeys, sessions). `Teacher` and `Student`
become profiles optionally linked to one account. Domain FKs never move.

Decisions made with the user:

1. **Stateless by route** — the session identifies the account only. Teacher
   pages serve accounts with a teacher profile; student pages serve accounts
   with a student profile. No active-role state, no switcher; cross-links
   between the two sides. Single-role users notice nothing.
2. **v1 scope** — model + auth migration + the payoff feature: a signed-in
   teacher on a booking page can create their student profile in place and
   book. Become-a-teacher onboarding is out of scope.
3. **Login landing** — with no explicit redirect, dual-role accounts land on
   the teacher home `/`; single-role accounts land on their only home.

## Data model

```prisma
model Account {
  id        String   @id @default(uuid())
  email     String   @unique
  createdAt DateTime @default(now())
  teacher   Teacher?
  student   Student?
}
```

- `Teacher.accountId String @unique` — **required** after backfill (every
  teacher authenticates).
- `Student.accountId String? @unique` — nullable: CRM-created unclaimed
  students (`claimedAt: null`) have no account until the human authenticates.
- **`Teacher.email` and `Student.email` stay.** All email-sending and CRM
  read paths are untouched. The auth layer maintains the invariant that a
  linked profile's email equals its account's email. Canonicalizing email
  onto Account is deliberately deferred.
- `Session`: `(userId, userType)` → `accountId` (indexed).
- `PasskeyCredential`: `(userId, userType)` → `accountId` (indexed). One
  passkey then opens both sides of a dual account.
- `MagicLinkToken` unchanged (email-keyed).

## Session shape

`getSession()` returns `{ accountId, teacherId: string | null, studentId:
string | null }`, resolved in one query via the Account relations.
Authorization becomes profile-presence:

- `(teacher)` group/layout and teacher APIs: require `teacherId`.
- `(student)` group/layout and student APIs: require `studentId`.
- A session whose account lacks the required profile redirects to its other
  home (or `/login` when signed out).

`createSession(db, accountId)` drops the userType parameter. Session id
stays the sha256 of the raw cookie token (unchanged).

## Auth flows

### Magic-link verify

1. Look up `Account` by token email.
2. Found → session for that account.
3. Not found, but an **unclaimed** `Student` row has this email → the claim
   moment: create Account, link `Student.accountId`, set `claimedAt`, mint
   session. (Makes today's implicit claim semantics explicit.)
4. Neither → "Account not found" (as today).
5. Redirect: stored token redirect if safe, else `teacherId ? '/' :
   '/bookings'`.

### Passkey authenticate

Credential → `accountId` → session. Same redirect fallback rule. The
schema-validated `redirect` passthrough (PR #8) is unchanged.

### Profile attachment principle (closes the live footgun)

**Profiles are only attached to an existing account from an authenticated
session — never by an unauthenticated signup route claiming an email.**

- **Teacher signup** (`POST /api/teachers`): email has an Account (either
  profile) → `409 EMAIL_TAKEN`. Fresh email → create Account + Teacher
  linked. (Strictly better than today, where a student's email silently
  creates a shadowing teacher.)
- **Student signup** (booking flow): email has an Account with a student
  profile → send sign-in link (as today). Account with only a teacher
  profile → send sign-in link too — the student profile is created after
  they authenticate, via the in-place join flow below. No account but an
  unclaimed Student row has this email → send the link; the claim happens
  at verify (magic-link rule 3). No account and no student row → create
  Account + claimed Student, send link. Responses stay indistinguishable
  (anti-enumeration).

## Payoff feature: teacher joins a class

Booking page (`/[slug]/book/[classId]`), session has `teacherId`, no
`studentId`: replace the dead-end sign-in form with a join panel —
"You're signed in as {firstName}. Set up your student side to join this
class." One button →

- `POST /api/account/student-profile` (authenticated; rejects if a student
  profile already exists): creates `Student` with name copied from the
  teacher profile, `email` = account email, `incomeTier` 3, `claimedAt`
  now, linked to the account.
- The page re-renders into the normal `BookingFlow`; the real tier is picked
  there and persists through the existing tier-update path.

Cross-links (rendered only when the other profile exists):

- Teacher settings index → "Your bookings as a student" → `/bookings`.
- Student account page → "Your teaching side" → `/`.

## Migration (one Prisma migration, backfill in SQL)

1. Create `Account`; add nullable `accountId` (unique) to Teacher and
   Student.
2. Backfill accounts from teachers (one per teacher, teacher's email).
3. Claimed students: link to the existing account with the same email if one
   exists (absorbs any already-shadowed dual emails into one healthy
   account), else create an account from the student's email. Unclaimed
   students: skipped.
4. `Session`/`PasskeyCredential`: add `accountId`, backfill by joining
   `userId`+`userType` through the profile tables, drop old columns and
   indexes. Sessions and passkeys survive; nobody is signed out.
5. Tighten `Teacher.accountId` to NOT NULL.

## Out of scope

Become-a-teacher onboarding; email-change flows; email canonicalization onto
Account; notification-model changes (recipients stay profile-scoped —
correct under stateless-by-route); GDPR flow redesign (erasure stays
per-profile; deleting an account's last profile deletes the account — only
the account-cleanup step is added to the existing flow).

## Testing

- **Unit:** claim-at-verify logic; profile-attachment rules; redirect
  fallback matrix (teacher-only / student-only / dual × redirect present or
  absent).
- **Integration:** teacher-signup 409 on existing account; student-signup
  branching (fresh / student exists / teacher-only account); student-profile
  endpoint auth + duplicate rejection.
- **E2e:** teacher signs in on another teacher's booking page → joins as
  student → books (the headline journey); unclaimed CRM student claims via
  booking signup as today; one passkey enrolled as a teacher signs into the
  student side after the join (shared credential proof); existing auth,
  booking, passkey and visual suites updated for the new session shape.

## Risks / blast radius

The migration is additive-plus-backfill and reversible until the old
columns drop. The wide-but-shallow part is the `getSession` shape change
(~12 files, ~30 `userType` branches) and the two route-group guards. The
e2e suites seed sessions directly (`userId`/`userType` rows) and must move
to account-based seeding — mechanical but touches most spec files.
