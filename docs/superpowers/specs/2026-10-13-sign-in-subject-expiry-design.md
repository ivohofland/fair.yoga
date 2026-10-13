# Sign-in email subject names its expiry (#825)

## Problem

Every sign-in email has the subject `Sign in to fair.yoga`
(`renderMagicLinkEmail`, `src/lib/email-templates.ts`). Gmail threads messages
with one subject from one sender, and inside a thread it trims content that
repeats an earlier message. Two sign-in emails differ only in the link, so the
second one shows as `•••`, with its **Sign in** button hidden. A second link
is usually requested because the first was slow, so this is a common path.

## Premise, as measured

- **Holds:** the subject is one constant, in one renderer. Every sign-in email
  reaches it through `deliverSignInLink` (`src/lib/auth/link-delivery.ts`),
  which three routes call: `magic-link/send` (via
  `deliverSignInLinkIfRegistered`), `teacher-signup` and `student-signup`.
- **Holds:** the request does not carry a timezone today. Re-derive the client
  call sites with
  `grep -rnE "auth/(magic-link/send|teacher-signup|student-signup)'" src --include='*.tsx' | grep -v '\.test\.'`.
- **Incomplete:** the issue says other subjects "already vary". The passkey-added,
  passkey-removed and payout-changed subjects are constant too. Their bodies
  include the event's time, though, so consecutive messages differ in content
  and Gmail has nothing identical to trim. Out of scope; noted in the PR.
- **Collisions:** the subject below is unique per second. The per-address rate
  limits on all three routes are 3 per 15 minutes, so two identical subjects
  need two sends within one second.

## Decision

Subject: `Sign in to fair.yoga · valid until 22:29:37 CEST`.

- The time is the token's stored `expiresAt`, rendered `en-GB`, `hourCycle:
  'h23'`, with seconds and `timeZoneName: 'short'`. European zones read as
  abbreviations (`CEST`); others as offsets (`GMT-4`). Both are unambiguous.
- The zone is the **requester's browser zone**, sent as an optional `timeZone`
  field by every client that posts to the three routes. That zone is correct
  for students (no stored zone), new signups (no profile) and travelling
  teachers alike.
- A missing or unrecognised zone renders in **UTC, labelled `UTC`**: never a
  silent guess. Real browsers always report a zone; the fallback is for scripts
  and old engines.
- Options rejected (issue thread): a meaningless number in the subject (A); a
  hidden random string in the body (C), which is moot once subjects never
  repeat, since trimming happens only inside a thread.

## Design

**Server.**
- `mintMagicLinkToken` (`magic-link.ts`) returns `{ token, expiresAt }`;
  `generateMagicLinkToken` stays as the wrapper returning only the token, so its
  existing callers and tests are untouched.
- `deliverSignInLink` takes an optional `timeZone` in its `opts`, mints with
  `mintMagicLinkToken`, and passes `expiresAt` and `timeZone` through
  `sendMagicLinkEmail` to `renderMagicLinkEmail`.
  `deliverSignInLinkIfRegistered` forwards the field.
- `renderMagicLinkEmail(magicLink, expiresAt, timeZone?)` builds the subject. The
  `<h1>` heading stays `Sign in to fair.yoga`.
- Schemas: `magicLinkSendSchema`, `teacherSignupSchema` (`.strict()`) and
  `studentSignupSchema` (`.strict()`) gain `timeZone`, reusing
  `detectedTimezoneField`'s semantics: an unrecognised value becomes `undefined`
  rather than a 400, because this is passive detection the person cannot
  correct. Bounded in length per the input-bounds rule; an over-long value is a
  400 for any address alike.

**Client.** `detectTimeZone` moves from `profile-setup-form.tsx` to a shared,
client-safe module and is called in each submit handler, never during render.
Its docblock already records the reason: a render-time read is the server's
zone (UTC in the container) and survives hydration.

**Not an oracle.** The zone comes from the requester and reaches only the email.
No response status, body, header or timing depends on it differently for a
registered and an unregistered address (`2026-10-07-sign-in-oracles-design.md`).

## Tests

- Unit (`email-templates.test.ts`): two expiry instants a second apart give
  different subjects; the time renders in the given zone (`Europe/Amsterdam` →
  `CEST`/`CET` by date); a missing zone renders `UTC`.
- Unit (`link-delivery.test.ts`): the zone passed to `deliverSignInLink`, and
  through `deliverSignInLinkIfRegistered`, reaches the send; the expiry passed is
  the stored row's `expiresAt`.
- Schemas: a valid zone is kept and modernised; an unknown one is dropped; the
  strict schemas accept the new key.
- Component tests: each form's request body carries `timeZone`.
- By hand: two sign-in emails in a row land as separate Gmail conversations.
