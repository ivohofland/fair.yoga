# One-click unsubscribe for opt-out-able mail (#801)

## Problem

No email the app sends carries `List-Unsubscribe`. Someone who wants less mail
and finds no unsubscribe in their client presses **Report spam**, and the
provider counts that against the sending domain — the domain that also carries
the magic link everyone needs to sign in. The app already lets people turn most
of this mail off; the message just doesn't offer it.

## What the issue got right, and what was measured instead

Measured on `be70214a` (main after #800).

- **The send seam exists.** Every send goes through `sendEmail` (`src/lib/email.ts`),
  whose `headers` field already reaches the Lettermint payload
  (`src/lib/email-lettermint.ts`). The issue's `grep -n "emails.send"` predates
  #800 and now matches nothing.
- **Eight send sites, two opt-out-able.**
  `grep -rnE "sendEmail\(" src | grep -v "\.test\."` = 9 lines = 1 definition +
  8 call sites. Opt-out-able today: the class reminder (`class-reminders.ts`)
  and the unread-notification fallback (`email-fallback.ts`). Not: magic link,
  invitation, passkey added, passkey removed, payout changed, operator digest.
  2 + 6 = 8. The invitation is the one this spec moves across the line.
- **The stranger invitation carries no token and no invitation id.** It links
  to `/login`; declining needs a signed-in student session
  (`invitations/[id]/respond`, `requireStudent`).
- **No signing secret exists.** Nothing in `src` uses `createHmac`; the one
  `timingSafeEqual` is `cron-auth.ts`, under an optional `CRON_SECRET`. The only
  token-link precedent is #786's `PayoutPauseToken`, a stored sha256 row.
- **`/u` is a legal teacher slug** (`RESERVED_SLUGS`, `src/lib/schemas.ts`), and
  Next.js cannot hold a `page.tsx` and a `route.ts` in one segment, so the
  issue's `GET`/`POST /u/<token>` cannot be one path. This spec uses the #786
  shape instead: a public page plus an `/api` route.
- **`parseBody` refuses non-JSON with 415**; the RFC 8058 POST is
  `application/x-www-form-urlencoded`.
- **Teacher "per-event choices" are three shapes:** `bookingNotifications` (enum
  `inbox_and_email | inbox_only | off`), `emailOnClassCompleted` and
  `emailOnInvitation` (booleans). `ReminderChannel` has an `email` member, so
  "drop the email half" has no answer there.
- **Erasure is a soft delete.** `Student`/`Teacher` rows survive with
  `deletedAt` set and the address rewritten; invitations are rewritten to a
  `deleted-…@deleted.invalid` address, or deleted outright with their teacher.
- **The `mailto:` form has no processor.** Nothing reads `ops@fair.yoga`
  automatically; a `mailto:` unsubscribe would be a promise the system cannot
  keep. RFC 8058 needs only the HTTPS URI. Dropped.
- **Holds as written:** the cross-origin description (`src/lib/cross-origin.ts`
  passes a request with neither `Origin` nor `Sec-Fetch-Site`), the policy's home
  in `notification-policy.ts`, and that a GET must never change anything.

## Decisions

1. **The token is HMAC-signed, not stored.** No migration, no row per email, no
   retention sweep. Cost: one new production secret, and rotating it voids every
   outstanding link — acceptable for a link whose worst failure is "go to
   settings instead".
2. **An invitation unsubscribe is a decline.** Same outcome as
   `declineInvitation`: the invitation becomes `declined` and a
   `TeacherBlock(teacherId, email)` is written, so that teacher cannot re-add
   the address; other teachers are unaffected. Authorised by the token instead
   of a session. No new table, no platform-wide suppression list.
3. **What each unsubscribe flips is the narrowest existing switch that stops
   that kind of mail:**

   | Mail | Kind | Unsubscribe sets |
   |---|---|---|
   | Student fallback, opt-out-able type | `student_notifications` | `Student.emailNotifications = false` |
   | Teacher fallback, `booking_confirmed` | `teacher_bookings` | `bookingNotifications`: `inbox_and_email → inbox_only` |
   | Teacher fallback, `payment_request` | `teacher_class_completed` | `emailOnClassCompleted = false` |
   | Teacher fallback, `teacher_invitation` | `teacher_invitations` | `emailOnInvitation = false` |
   | Class reminder, student / teacher | `student_reminders` / `teacher_reminders` | channel `inbox_and_email → inbox`; channel `email` → `classReminder = off` |
   | Stranger invitation | `invitation` | decline + `TeacherBlock` |

   The student has one email switch, so one kind covers every opt-out-able
   student type; anything narrower needs new columns and is not this issue.
4. **No `mailto:`.** See above.
5. **`/api/unsubscribe` is exempt from the cross-origin check.** That check
   guards cookie-authenticated writes; this route reads no session and the token
   is its whole authorisation, so a foreign `Origin` forges nothing. Without the
   exemption a webmail client POSTing from the browser is refused.

## Design

### Policy, tethered (send side)

- `EmailMessage` gains a **required** `unsubscribe: UnsubscribeTarget | null`
  (`{ kind, subjectId }`). Every call site must decide; a new sender cannot
  forget. `sendEmail` turns a target into both headers and `null` into neither;
  it is the only place the headers are spelled.
- `notification-policy.ts` gains the per-type mapping beside
  `shouldEmailStudent`/`shouldEmailTeacher`: an exhaustive
  `satisfies Record<…>` from each student `NotificationType` and each
  `TeacherNotificationType` to its kind or `null`. Essential types map to
  `null`, so the header follows the same classification that decides whether
  the mail is optional at all. A test pins that a type maps to a kind exactly
  when the corresponding `shouldEmail*` answer depends on a preference —
  constant-true types (essential) and constant-false ones (teacher
  `class_reminder`, never emailed by the fallback) map to `null`.
- The six never-opt-out senders pass `null`; each has an explicit test that its
  message carries no `List-Unsubscribe`, the magic link first.
- The three opt-out-able footers (fallback, reminder, invitation) gain a
  visible "Unsubscribe" link to the confirm page, so the opt-out is reachable in
  clients that show no native button.

Headers, when a target is present and a secret is configured:

```
List-Unsubscribe: <https://fair.yoga/api/unsubscribe?t=<token>>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

### Token (`src/lib/unsubscribe-token.ts`)

`base64url("v1." + kind + "." + subjectId) + "." + base64url(HMAC-SHA256(key, "unsubscribe:" + payload))`.

- Key: `UNSUBSCRIBE_SECRET`, at least 32 bytes. Production without it: mail
  still sends, without the headers or footer link, and a warning is logged once
  (mirrors `LETTERMINT_CLASS_ROUTE`). Outside production a fixed development
  key is used.
- Verification parses, recomputes, compares in constant time, and checks `kind`
  against the closed `UnsubscribeKind` union. It returns the target or `null`;
  it never touches the database.
- Single-purpose by construction: the key is used for nothing else and the MAC
  input is prefixed `unsubscribe:`, so no other token this app mints can verify
  here, and this token is accepted nowhere else.
- No expiry: unsubscribe links are used months later.

### Service (`src/services/unsubscribe.ts`)

`unsubscribe(db, target)` → `{ status: 'done' } | { status: 'unchanged' } | { status: 'invalid' }`.
Framework-agnostic; one transaction.

- Resolves the subject: a `Student`/`Teacher` with `deletedAt` null, or an
  `Invitation` whose address is not a tombstone. Missing, erased and tombstoned
  all answer `invalid` — one answer, so the route cannot tell "never existed"
  from "erased" (the uniform-answer rule of
  `2026-10-07-sign-in-oracles-design.md`, as `PAUSE_LINK_INVALID` applies it).
- Applies the switch from the table. Already off → `unchanged`. An invitation
  already `declined` or `accepted` → `unchanged`: either way no more invitation
  mail comes from that teacher.
- Invitation decline reuses the write `declineInvitation` performs (status +
  `TeacherBlock` upsert), extracted so both paths share it rather than copy it.

### Routes

- `POST /api/unsubscribe?t=<token>`, body `List-Unsubscribe=One-Click`
  (form-encoded, parsed by the route; anything else is 400). `invalid` → 404
  `UNSUBSCRIBE_LINK_INVALID` (new registered code); `unchanged` →
  `respondUnchanged`; `done` → 200. No session read. Rate-limited with
  `checkIpRateLimit('unsubscribe', …)` at a generous cap, since provider POSTs
  share IPs and the MAC makes guessing pointless.
- `GET /api/unsubscribe?t=<token>` → 303 to `/unsubscribe#t=<token>`. Changes
  nothing. The fragment keeps the token out of logs from there on.
- `withErrorHandler` gains an explicit opt-out of the cross-origin check, used by
  this route only; a test pins that it is the only caller.
- `/unsubscribe` — public page in the design system. Reads the token from the
  fragment client-side and, from its `kind`, says what will change; a confirm
  button POSTs; a link goes to the notification settings. It shows the same page
  for a forged token until the POST answers, so the page itself is no oracle.
  `unsubscribe` joins `RESERVED_SLUGS`.

## Testing

- Unit: token round-trip, tamper (payload, MAC, kind), wrong key, unknown kind;
  policy mapping exhaustive and agreeing with `shouldEmail*`; `sendEmail`
  header building; each never-opt-out sender carries no header.
- Integration: each kind flips exactly its switch and nothing for any other
  recipient or kind; repeat → unchanged; forged / erased / tombstoned /
  teacher-deleted invitation → identical 404; GET changes nothing and 303s;
  foreign-`Origin` POST is accepted; rate limit; JSON body refused.
- Component/e2e: the confirm page per kind, and the invalid-link state.

## Docs

- `docs/technical-architecture.md`: the token, the route, `UNSUBSCRIBE_SECRET`
  in the env table.
- `DEPLOYMENT.md`: set `UNSUBSCRIBE_SECRET`; check at cut-over that Lettermint's
  DKIM signature covers `List-Unsubscribe` and `List-Unsubscribe-Post`; check
  that no teacher already holds the slug `unsubscribe`.

## Out of scope

- A per-type student switch (needs new columns).
- Platform-wide invitation suppression.
- Unsubscribe for the six essential senders — by design.
