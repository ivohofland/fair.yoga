# Credentials outlive the session that minted them (#765)

## As built

Where the build differs from the text below, which is the design as argued
before building:

- **Sign out everywhere also deletes the account's push subscriptions**, in the
  same transaction as the sessions (`signOutEverywhere`,
  `src/services/account-sign-out.ts`): a subscription is keyed by account, not
  session, so it would keep delivering to a signed-out device. The client also
  calls `disablePush()` first, waiting at most 3 seconds.
- **`AddPasskey` was folded into `AccountSecurity`** and `add-passkey.tsx` is
  deleted; the step-up offer ("Email me a sign-in link") is `AccountSecurity`'s.
- **Email copy** is as shipped in `renderPasskeyAddedEmail`
  (`src/lib/email-templates.ts`): it names the passkey being added, the UTC
  time, and where to find passkeys (Settings → Profile for teachers, Account
  for students) with remove-then-sign-out-everywhere. It carries no link.
- **Rate limit:** none new, the "otherwise none new" branch below.
- **Session-issuing doors are five**, not two; the roster and the commands that
  re-derive it are in `docs/technical-architecture.md` (Session-issuing
  doors).
- **Premise row 1** ("deletion only in `services/gdpr.ts`") describes the state
  before this change; the delete route now exists.

Autonomous run (no brainstorm gate with the user); every decision below is
mine and is argued, so a reviewer can overrule it.

## Premise check (each item re-verified in code)

| # | Claim | Verdict |
|---|---|---|
| 1 | Passkey registration needs only `requireSession`; no list/delete route; no email; no sign-out-everywhere | **Holds.** `register/options` and `register/verify` call only `requireSession`. `PasskeyCredential` has no label column. `grep -rn passkeyCredential src` shows deletion only in `services/gdpr.ts`. |
| 2 | `session.createdAt < fifteenDaysAgo` never changes, so every request after day 15 pushes `expiresAt` | **Holds** (`src/lib/auth/session.ts`). Extra: the cookie `Max-Age` is a fixed 30 days from sign-in and is only ever set at sign-in, so the legitimate browser drops its cookie at day 30 while a stolen copy lives on. |
| 3 | SSE checks the session once at connect | **Holds** (`api/notifications/stream/route.ts`). |
| 4 | Offline cache outlives a session ended elsewhere; fix `Clear-Site-Data: "cache"` | **Partly wrong.** (a) Local sign-out and delete-account already call `clearOfflinePages()` (`sign-out-button.tsx`, `data-and-deletion.tsx`). (b) `public/sw.js` already empties the page cache on any redirect response (`handleCacheablePage`, `warm`), and a session revoked elsewhere makes the next online page request redirect to login, so "purge on next contact" already exists. (c) `Clear-Site-Data: "cache"` targets the HTTP cache; Cache Storage (where the worker keeps pages) is under `"storage"`, which would also wipe IndexedDB, and with it the unsynced offline check-in queue (`2026-10-04-offline-checkin-design.md`). Shipping the suggested header would be inert or destructive. |

## Decisions

### 2 · Absolute session lifetime
- `ABSOLUTE_LIFETIME_MS` = 90 days from `createdAt`. A session at or past it is
  deleted and answers `null`, like an expired one.
- Extension fires only when `expiresAt - now < 15 days`, and sets
  `expiresAt = min(now + 30d, createdAt + 90d)`. A steady user costs one write
  per ~15 days instead of one per request after day 15.
- Cookie `Max-Age` becomes the 90-day ceiling (the server enforces the real
  expiry), so the legitimate browser no longer loses its cookie at day 30
  while the server would have kept it alive.
- No migration: `createdAt` and `expiresAt` already exist.

### 3 · Stream revalidation
- Each 30 s keepalive tick calls `validateSession` with the connect-time token;
  `null` closes the stream. A thrown database error keeps the stream (a DB blip
  must not sign everyone's tab out) and is logged.
- Bound: a revoked session hears events for up to one tick (30 s), which is the
  issue's own stated bound.

### 1 · Passkeys
- **Recent authentication = `Session.createdAt` within 5 minutes.** Every
  sign-in door (`magic-link/verify`, `passkey/authenticate/verify`) mints a new
  session, so `createdAt` is time of last authentication; no schema change.
  Applies to `register/options` and `register/verify` (both, so a session that
  ages out between the two steps cannot finish). Refusal: `403
  RECENT_AUTH_REQUIRED` (new registered code).
- **Step-up UI:** on that refusal, `AccountSecurity` offers "Email me a sign-in
  link" (existing `magic-link/send`, `redirect` back to the same page). Clicking
  the link mints a fresh session, which passes the gate.
- **Email on every new passkey:** `deliverPasskeyAddedNotice` returns
  `FireAndForget` (failure must not fail or slow the registration, which has
  already committed). Sent to `Account.email` after the credential row exists.
  Copy says what happened, when, and where to revoke ("Settings → sign out
  everywhere").
- **List/delete:** `GET /api/auth/passkey` lists the caller's credentials
  (`id`, `createdAt`, `transports`; never `publicKey`/`counter`).
  `DELETE /api/auth/passkey/[id]` deletes by `{ id, accountId }`; a credential
  of another account answers the same 404 as a missing one (gate 4, no
  existence oracle). Deleting is *not* recent-auth gated: it only removes a way
  in, and a locked-out owner still has the magic link.
- **Sign out everywhere:** `DELETE /api/auth/session/all` deletes every
  `Session` for the account (current one included), clears the cookie and
  answers 200; the client then runs `clearOfflinePages()` and goes to `/login`.
  Idempotent. Not recent-auth gated (it can only lock an attacker out).
- **UI:** one `AccountSecurity` client component, rendered where `AddPasskey`
  is today (`settings/profile`, student `account`): passkey list with Remove,
  Add, and Sign out everywhere. Mobile-first rows per the design brief; words
  not icons.
- Rate limit: reuse the existing per-account limiter pattern if one exists for
  passkey registration; otherwise none new (all routes need a session).

### 4 · Offline cache
- **No `Clear-Site-Data`** (see premise table). The one real gap is the device
  that *performs* "sign out everywhere": its UI calls `clearOfflinePages()`.
  Other devices are purged by the existing redirect path on next online contact;
  a shared device that stays offline keeps ≤ 24 h of pages, accepted because 24 h
  is the feature (teaching in a studio with no signal).
- #765's item 4 is therefore closed by documentation, not code. Recorded in
  `docs/technical-architecture.md` (auth section) so the next reviewer does not
  re-propose the header.

## Out of scope
- Passkey labels/renaming (no column; list shows the added date).
- Revoking individual sessions (a device list); only all.
- `Clear-Site-Data`.

## Tests (test-first, each guard mutation-proven)
- `session.test.ts`: absolute ceiling; no write inside the 15-day window;
  extension capped at the ceiling; cookie Max-Age.
- SSE: keepalive closes on revoked session; survives a DB error.
- Integration: register options/verify refuse with `RECENT_AUTH_REQUIRED` on an
  old session, pass on a fresh one; email notice triggered; list never exposes
  key material; delete 404s for another account's credential and does not delete
  it; sign-out-everywhere kills every session of the account and none of
  another's.
- Component: AccountSecurity list/remove/step-up/sign-out-everywhere.
