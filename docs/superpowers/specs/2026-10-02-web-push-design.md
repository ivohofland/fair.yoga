# Web Push for notifications (#724)

Part of tracking issue #727, second in its order. Builds on #723 (installable
app, merged as PR #738): iOS delivers web push only to a site installed to the
home screen. #725 (read-only offline) and #726 (offline check-in) are
unaffected; this PR introduces the first service worker and deliberately gives
it no `fetch` handler, so offline behaviour stays #725's to introduce.

## 1. What the issue assumed, and what holds

Measured on `feat/724-web-push` off `origin/main` at `ea7b38e4`.

| Issue's premise | Measured |
|---|---|
| SSE stream is `src/app/api/notifications/stream/route.ts` and stops when iOS backgrounds the app | **Holds.** An in-process `EventEmitter` (`src/lib/event-bus.ts`); the client (`live-updates.tsx`) treats each event as a `router.refresh()` hint. |
| Email fallback after 30 min unread, sooner near class time | **Holds, loosely.** The sweep runs every 5 min (`scheduler.ts`, job `email-fallback`), so "30 min" is 30–35. "Near class time" is `URGENT_WINDOW_MINUTES = 120` (`notification-policy.ts`). |
| Walk-in and promotion notices already skip the 30-minute wait | **Holds, and is incomplete.** `IMMEDIATE_EMAIL_TYPES` is `{waitlist_promoted, walk_in_added}`; `spot_available` and `spot_taken` are effectively immediate too, because the 60-min claim window sits inside the 120-min urgent window. |
| The final-hour waitlist broadcast is first-to-claim | **Holds, implemented.** `handleSpotFreed` (`waitlist.ts`) sends `spot_available` to every waiter inside `CLAIM_WINDOW_MINUTES`; `claimSpot` takes the seat; `spot_taken` follows on fill. |
| "Hook into the notification-creation path", fire-and-forget | **Would leak.** Both creation helpers (`createNotification`, `createBulkNotifications`, `src/services/notifications.ts`) run inside the caller's transaction; `emitToBus` fires *before* commit. Its docblock accepts that only because SSE payloads are never rendered. A push renders title and body on a lock screen, so it must read committed rows. `createBulkNotifications` also emits the placeholder id `'bulk'`. §3.2 dispatches from committed rows instead. |
| Push delivery "must not hold up the request: see `FireAndForget`" | **Met structurally.** No request calls the sender (§3.2), so there is nothing to await; no `FireAndForget` function is introduced. |
| The push opens "the same link the inbox row uses" | **That link is not stored.** It is computed at read time (`studentNotificationHref` / `teacherNotificationHref`, `src/lib/notification-links.ts`), from a class join, and is `null` for many rows; email uses different links (`STUDENT_ACTION_LINKS`, `email-templates.ts`). §3.4 opens the inbox at the row instead. |
| "Push follows the same essential/optional split as email" | **Undefined for teachers.** The split exists only for students (`ESSENTIAL_NOTIFICATION_TYPES`); teachers have per-type rules (`TEACHER_EMAIL_POLICY`), and class reminders have their own `ReminderChannel`. Decided instead: per-group push preferences (§2). |
| A subscription keyed by account, cleaned up on erasure | **A cascade would never fire.** `Account` rows are never deleted; erasure deletes `Session` and `PasskeyCredential` explicitly by `accountId` (`deleteStudentAccount`, `deleteTeacherAccount` in `gdpr.ts`). §3.6 adds `PushSubscription` beside them. |
| Use `web-push` or an equivalent | **Not needed.** `node:crypto` covers ES256 (VAPID) and P-256 ECDH + HKDF + AES-128-GCM (RFC 8291). `web-push` 3.6.7 (last published 2024-01) brings five direct dependencies. §3.3. |

Call-site arithmetic for the creation path:
`grep -rnE "\b(createNotification|createBulkNotifications)\s*\(" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | wc -l`
→ 21 lines − 2 function definitions = 19 call lines. A sweep (§3.2) needs no
edit to any of them.

## 2. Decisions

1. **Both students and teachers get push.**
2. **Push never replaces email.** Email is the guarantee; push is a
   best-effort extra layer. A push service's `201` means *accepted*, not shown
   or seen. Push never writes `isRead` or `emailSent`; the email-fallback sweep
   is untouched. Someone may get the push and, later, the email.
3. **A tap does not mark a notification read.** It opens the inbox at that
   row; reading happens through the inbox's existing row tap, which is what
   already stops the email.
4. **Per-group push preferences, on the profile.** Push is "things that
   happened *to* you, not *by* you": a student's own booking and own
   cancellation never push.

   **Student** (`/account/notifications`)

   | Group (column) | Types | Default |
   |---|---|---|
   | Waitlist spots (`pushWaitlist`) | `waitlist_promoted`, `spot_available`, `spot_taken` | on |
   | Class changes (`pushClassChanges`) | `class_cancelled`, `booking_removed`, `walk_in_added` | on |
   | Payments (`pushPayments`) | `payment_request`, `reminder` | off |
   | Class reminders (`pushClassReminders`) | `class_reminder` | off |
   | Announcements (`pushAnnouncements`) | `announcement` | off |
   | Invitations (`pushInvitations`) | `teacher_invitation` | off |
   | never | `booking_confirmed`, `booking_cancelled` (own actions), `payment_received` (no writer) | — |

   **Teacher** (`/settings/notifications`)

   | Group (column) | Types | Default |
   |---|---|---|
   | Auto-cancelled classes (`pushAutoCancelled`) | `class_cancelled` | on |
   | New bookings (`pushBookings`) | `booking_confirmed` | off |
   | Class completed (`pushClassCompleted`) | `payment_request` | off |
   | Class reminders (`pushClassReminders`) | `class_reminder` | off |
   | Invitations (`pushInvitations`) | `teacher_invitation` | off |
   | never | every type outside `TeacherNotificationType` | — |

   On by default: only what is time-critical. Nothing pushes until the person
   also enables push on a device. Existing creation-time gates stay where they
   are (a teacher's `bookingNotifications = 'off'` writes no row; a reminder
   whose channel is `email` writes no row), so push never sees those rows.
5. **The lock screen shows the notification's own title and body**, except
   money: the Payments and Class-completed groups replace the body (§4).
6. **Dispatch is a fast sweep over committed rows** (§3.2), not a
   creation-path hook, `LISTEN/NOTIFY`, or per-call-site dispatch.
7. **The sender is ours, on `node:crypto`**, pinned byte-exact to RFC 8291's
   own test vector.
8. **No app-icon badge** — `setAppBadge` is never called.
9. **Installed app only.** Push is offered only where fair.yoga runs as the
   installed app (`display-mode: standalone`, #723's `useInstallSupport()` →
   `installed`), on every platform — no browser-tab or desktop-browser
   notifications. A browser tab shows how to install instead. This is a
   client-side gate: the server cannot tell an installed app's subscription
   from a tab's, and does not try.

## 3. Design

### 3.1 Data model (one migration)

- **`PushSubscription`**: `id`, `accountId` (indexed, no FK cascade — see §1),
  `endpoint` (unique), `p256dh`, `auth`, `createdAt`, `lastUsedAt`. One row per
  device per account. No user agent or device label (privacy first).
- **`Notification.pushHandledAt DateTime?`** with `@@index([pushHandledAt, createdAt])`
  — expressible in Prisma, so no hand-authored SQL. The sweep retires every
  row it sees (§3.2), so the unhandled set stays a few seconds' worth.
- **Boolean push columns** on `Student` and `Teacher` (§2.4), following the
  existing `emailOnClassCompleted` / `emailOnInvitation` style.

### 3.2 Dispatch: `dispatchPushes(db, send)`

A scheduler job, `push-dispatch`, every 10 s (`src/lib/scheduler.ts`):

1. Retire stale rows: `pushHandledAt IS NULL AND createdAt <= now() − 15 min`
   are marked handled without sending — rows written while the job was down,
   or before this feature existed. Then select rows with
   `pushHandledAt IS NULL AND createdAt > now() − 15 min`, oldest first,
   capped per tick (the plan sets the cap). Rows only exist once committed,
   so a rolled-back notification is never found.
2. Claim each with a compare-and-swap
   (`UPDATE … SET pushHandledAt = now() WHERE id = ? AND pushHandledAt IS NULL`),
   the `claimEmailFallback` shape; an overlapping manual run cannot double-send.
3. Resolve the recipient profile → `accountId` and push columns. No account
   (an unclaimed walk-in student) or an erased profile: handled, skipped.
4. `shouldPush(audience, type, prefs)` (§3.5). If true, send to each of the
   account's subscriptions through `createConcurrencyLimit`
   (`src/lib/concurrency-limit.ts`).
5. Rows older than the cutoff are never pushed (step 1). A "spot available" push for a
   seat that went 50 minutes ago would mislead; inbox and email still carry it.

Send outcomes: **404/410** deletes the subscription; **2xx** sets
`lastUsedAt`; **anything else** (429, 5xx, network) logs at `warn` and is not
retried — email is the backstop, and a retry risks showing a stale race notice.

`send` is injected so integration tests record calls instead of reaching a
push service.

Missing VAPID configuration: the job marks rows handled without sending and
logs once per process; the settings section reports push unavailable.

### 3.3 Sender: `src/lib/push/`

- `vapid.ts` — the RFC 8292 JWT (ES256, `crypto.sign` with
  `dsaEncoding: 'ieee-p1363'`), `aud` = the endpoint's origin, `exp` ≤ 24 h,
  `sub` = `VAPID_SUBJECT`.
- `encrypt.ts` — RFC 8291 `aes128gcm`: ephemeral P-256 ECDH, HKDF, AES-128-GCM,
  single record.
- `send.ts` — POST with `TTL` (below the 15-min cutoff), `Urgency: high` for
  the Waitlist and Class-changes / Auto-cancelled groups, `normal` otherwise.
  Returns a typed outcome (`delivered` / `gone` / `failed`), never throws for
  an HTTP status.
- Payload: `{ id, title, body, url }`; `url` is `/updates?n=<id>` (student) or
  `/inbox?n=<id>` (teacher), chosen by `recipientType`.
- Env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:`),
  in `.env.example`, `DEPLOYMENT.md` and `docs/technical-architecture.md`
  (Environment Variables). `pnpm run vapid:keys` generates a pair with
  `node:crypto`. The public key reaches the browser as a server-component
  prop: the Docker build has no build args, so `NEXT_PUBLIC_*` would not be
  inlined.

### 3.4 Service worker and landing

- **`public/sw.js`**, push only, **no `fetch` listener**.
  `push` → `showNotification(title, { body, tag: id, data: { url } })` (iOS
  revokes a subscription whose pushes show nothing; every push here shows).
  `notificationclick` → focus an open fair.yoga window and navigate it to
  `url`, else `openWindow(url)`.
- Registered from the push settings section only, and only inside the
  installed app (§2.9) — never on every page.
  Same-origin `/sw.js` is already allowed by the CSP (`next.config.ts`:
  `script-src 'self'`, no `worker-src`); scope `/` needs no
  `Service-Worker-Allowed`.
- **Inbox landing**: `/updates` and `/inbox` read `?n=<id>`; that row gets the
  one-step tint and `aria-current="true"` — no scroll animation, nothing
  marked read.

### 3.5 Policy: `src/lib/push-policy.ts`

`STUDENT_PUSH_GROUP satisfies Record<NotificationType, StudentPushGroup | 'never'>`
and `TEACHER_PUSH_GROUP satisfies Record<TeacherNotificationType, TeacherPushGroup>`;
each group names its profile column. A new `NotificationType` is a compile
error until it is filed. `shouldPush` is the lookup plus the column.
`lockScreenBody` maps each group to `'own'` or `'redacted'` (§4) with the same
`satisfies Record<…>` tether; the payload's `body` is resolved through it.
`notification-policy.ts` (email) is untouched.

### 3.6 Routes, settings, sign-out, erasure

- **`POST /api/push/subscriptions`** (`requireSession`, new `RateLimitPrefix`):
  validates an `https:` endpoint and key lengths; upserts by `endpoint`. An
  endpoint held by another account moves to the caller — whoever holds the
  browser that minted the secret endpoint owns that device now, and refusing
  would keep the previous account's notifications flowing to it. The device
  reaches that POST by two paths: the push settings page's mount effect
  (`PushDeviceControl`), and `recordPushDeviceForSignIn` (`push-client.ts`),
  which the client calls wherever a response has just minted a session, so the
  new account claims the device without visiting settings (#745). The server
  side of that set is every route that calls `createSession` — a signup's
  session is minted by its profile POST, not by the magic link, so the two
  profile routes count (on their ticket path only). Re-derive both sides with
  `grep -rln createSession src/app/api --exclude='*.test.ts'` and
  `grep -rn "recordPushDevice" src --include='*.tsx'`; each route's client
  caller should appear in the second. It acts only on a subscription the
  browser already holds under a granted permission: no prompt, no subscribe,
  no request otherwise. It is best effort — a failure is logged and leaves the
  device recorded for the previous account until the next re-record. A caller
  whose next step is a full page load awaits it through
  `recordPushDeviceBeforeNavigation` (bounded); the others fire and forget.
- **`DELETE /api/push/subscriptions`** (`requireSession`): deletes only the
  caller's row; a missing or foreign row answers `respondUnchanged`. The
  endpoint is an unguessable capability, so the uniform answer discloses
  nothing.
- **Settings section**, on both notification pages. Device states:
  `unsupported` · `needs-install` (anything but #723's `installed`, on every
  platform — §2.9; points at the existing install steps) · `off` · `on` · `blocked`
  (permission denied: explains the OS setting, cannot re-ask) ·
  `unavailable` (no VAPID config). "Turn on for this phone" requests
  permission only on that tap. Group checkboxes save through the existing
  profile PUTs (`/api/teachers/[id]`, `/api/students/[id]`, schemas in
  `src/lib/schemas.ts`) and show even while the device is off.
- **Sign-out** (`sign-out-button.tsx`): before `DELETE /api/auth/session`,
  `pushManager.unsubscribe()` on this device, then `DELETE` the endpoint.
  The browser-side unsubscribe is the half that matters — it kills the
  endpoint at the push service; a failed server delete is cleaned up by the
  next send's 410.
- **Erasure** (`gdpr.ts`): delete `PushSubscription` by `accountId` in the
  branch that deletes `Session`/`PasskeyCredential`; reset the erased
  profile's push columns to `false`, as `emailNotifications` is.
- **Export** (`exportStudentData`, `exportTeacherData`): include the push
  columns beside the existing preference fields. Subscriptions are not
  exported, matching sessions and passkeys.
- **Route census** in `docs/technical-architecture.md` (Unauthenticated API
  routes) re-derived with its own command.

## 4. Lock-screen copy

A push is the first channel whose audience is not only the account holder:
a lock screen is read by whoever is beside the phone. Every title and body
passed to the two creation helpers was read (the 19 call lines of §1).

| Content | Where | Lock-screen treatment |
|---|---|---|
| A student's own price (`€…`), which reveals their income tier | `payment_request` to a student (`completeClass`, `class-lifecycle.ts`, all three variants of `payment-request-copy.ts`); `reminder` (`payment-reminders.ts`, `payments.ts`) | **Body replaced** |
| Attendance ("We missed you at…") | the no-show variant of `payment_request` | **Body replaced** (same group) |
| A teacher's net earnings | teacher `payment_request` ("Class completed") | **Body replaced** |
| The teacher's raw announcement text | `announcement` (`announcements.ts`) | Shown — the student opted into that group to receive exactly these messages |
| Class type, day and time; the student's own teacher's name; a booking student's first name to their teacher | every other type | Shown |

No title or body contains an income tier or tier ratio, and none shows one
student's data to another. Class type is teacher free text in every channel,
email included; push adds nothing there.

The rule: for the student **Payments** group and the teacher **Class
completed** group, the push keeps the stored title and replaces the body with
a fixed line — "Open fair.yoga to see the details." Every other group shows
its own body. It is one `lockScreenBody` entry per push group in
`push-policy.ts`, so a new group cannot be added without choosing.

## 5. Testing

Test-first. Every guard is broken once, its exact failure text recorded, and
restored.

- **Unit**: RFC 8291 Appendix A byte-exact encryption; VAPID JWT verifies
  against its public key and carries `aud`/`exp`/`sub`; `shouldPush` as a
  table over every `NotificationType` × audience × column; `lockScreenBody`
  per group (a Payments push carries no `€`); device-state
  classifier; send-outcome mapping per status.
- **Integration** (real DB, injected `send`): rolled-back notification never
  pushed; past-cutoff row never pushed; preferences honoured; 410 deletes the
  subscription; 500 not retried; overlapping runs send once; `isRead` and
  `emailSent` untouched; unclaimed student skipped. Routes: 401, ownership,
  endpoint reassignment, `respondUnchanged`; erasure deletes subscriptions
  and resets columns; export includes columns.
- **Component**: the settings section in each device state; the `?n=`
  highlight on both inboxes.
- **E2E**: none for delivery — headless Chromium cannot reach a real push
  service.
- **Manual acceptance** (real devices, recorded in the PR): an installed
  iPhone and an installed Android app receive a push for a default-on group
  with the app closed, and the tap lands on the highlighted inbox row; turning
  push off, and signing out, stops delivery to that device. A plain browser
  tab shows the install steps and no button.

## 6. Docs

- CLAUDE.md → Communication: push as a best-effort layer that never replaces
  email; a tap opens the inbox; per-group preferences.
- `docs/technical-architecture.md`: the push section, Cron Jobs entry,
  Environment Variables, and the "Notification Dispatcher" pseudocode, which
  shows an awaited dispatch the code does not do.
- `docs/data-model.md`: `PushSubscription`, `Notification.pushHandledAt`, the
  push columns.

## 7. Not in scope

- Offline caching or any `fetch` handling in the service worker (#725).
- Push for `booking_confirmed` / `booking_cancelled` to the student who caused
  them, ever.
- Retrying a failed push.
- A badge count.
