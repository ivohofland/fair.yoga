# Bare-catch census classification (#692)

Measured at `347221df` (origin/main when #692 started). Every site read in context. Line numbers are as of that commit — a record, not a maintained index.

Re-derive the site list (an AST census; a `grep 'catch {'` also matches comments and reported 80):

```
pnpm exec eslint -f json -o census.json \
  --rule '{"no-restricted-syntax":["error",{"selector":"CatchClause[param=null]","message":"BARECATCH"}]}' src
```

then count the `BARECATCH` messages in files not matching `*.test.ts(x)`.

Legend. **Cat**: T = transport-failure catch (bind `err` + log); B = correct as bare; L = logs but doesn't bind; O = other.
**Scope** (T only): what the `try` wraps besides the fetch; "narrow?" recommendation. `readError`/`readErrorMessage` (`src/lib/client-errors.ts`) never throw (they catch and log themselves), so they are not flagged.
**Ctx / tag**: identifiers in scope for the log context object, and a suggested tag. "PII" = a value in scope that must NOT go into the log (email, magic-link code, names, privacy values).
**Env**: C = `'use client'`; S = server-only.
**Tests**: the file that exercises the catch's path. "no spy" = the test reaches the catch without a `console.error` spy, so once the catch logs it will print to stderr (noise, not a failure — see Setup findings).

## Setup findings (vitest)

- `vitest.config.ts` has no `onConsoleLog`, no `silent`, no `restoreMocks`/`clearMocks`; the `components` project's only setup file `tests/setup/components.ts` registers jest-dom and mocks `next/navigation` — nothing fails a test on `console.error`. `package.json` has no `vitest-fail-on-console`. So converting catches to log cannot fail a test by itself; it only breaks tests that **assert** on console output (see the O rows and #60).
- Tests that DO assert against new console output: `studio-template-form.test.tsx:569` and `template-form.test.tsx:1195` assert `expect(errorSpy).not.toHaveBeenCalled()` and `warnSpy` `toHaveBeenCalledWith(msg, null)` on the path where the bare catch at #30/#32 is the expected route; `finish-window.test.ts:75` asserts `log.error` with the exact object `{ timeZone: 'Not/AZone' }` (#60).
- Lint note: `eslint.config.mjs` already has a shared `no-restricted-syntax` block for `src/**/*.{ts,tsx}` (teacherStudent + `classLockCastSelector`), plus a `src/services/roster-link.ts` override. In flat config a later block that sets `no-restricted-syntax` for an overlapping file **replaces** the earlier options, so a new `CatchClause[param=null]` selector scoped to `src/components/**`/`src/app/**` must either go into that shared block (and then also reach `src/lib`, needing disables there) or repeat the two existing selectors in its own block.

## Table

| # | Site | Cat | Try scope / narrowing (T) · or rationale (B/L/O) | Ctx vars · tag | Env | Tests |
|---|---|---|---|---|---|---|
| 1 | `src/app/(public)/login/page.tsx:35` | T | fetch + `setStatus` only. No narrowing. | none safe (`email` PII; `redirect` ok) · `[login]` | C | `login/page.test.tsx`: no network-error test |
| 2 | `src/app/(teacher)/class/new/page.tsx:190` | T | rooms load: fetch, `res.json()`, `setAllRoomsCount`, `.filter`, `setTeacherRooms` — all trivial. No narrowing. | none needed · `[class-new] rooms load failed` (file already uses `[class-new]`) | C | `class/new/page.test.tsx:579` "distinguishes a thrown fetch…" — no spy |
| 3 | `src/app/api/notifications/stream/route.ts:47` | B | `controller.enqueue` after close → cleanup. Comment above `send` (L41-42) explains. | — | S | — |
| 4 | `src/app/api/notifications/stream/route.ts:79` | B | `controller.close()` "already closed". Comment in catch. | — | S | — |
| 5 | `src/app/api/students/[id]/route.ts:188` | B | `JSON.parse` probe → `null` → 400. No comment (self-evident). | — | S | — |
| 6 | `src/components/account/data-and-deletion.tsx:42` | T | Export: fetch, `res.blob()`, then `URL.createObjectURL`, anchor create/click, `revokeObjectURL`. Narrow: keep fetch+blob in try, do the DOM download after it — a DOM throw currently reads "Network error". | `role` · `[data-and-deletion] export failed` | C | `data-and-deletion.test.tsx`: no network-error test |
| 7 | `src/components/account/data-and-deletion.tsx:60` | T | Delete: fetch + `router.push('/login')` + `router.refresh()`. Narrow: move push/refresh after the try (flag on `res.ok`). | `role` · `[data-and-deletion] delete failed` | C | no network-error test |
| 8 | `src/components/account/set-up-student-side.tsx:30` | T | fetch + `router.push` + `setTimeout`. Narrow: push after the try. | none · `[set-up-student-side]` | C | `set-up-student-side.test.tsx`: no network-error test |
| 9 | `src/components/account/sign-out-button.tsx:28` | T | fetch + `cleared = res.ok` only (push/refresh already in `finally`). Catch has comment only. No narrowing. | none (`redirectTo` optional) · `[sign-out-button]` | C | `sign-out-button.test.tsx:51` "still leaves… when the DELETE itself fails" — no spy |
| 10 | `src/components/auth/handoff-code-entry.tsx:50` | T | fetch, `res.json()`, `window.location.assign`, `readErrorMessage`. `assign` is low-risk; optionally move it after the try. | none — `code` is a sign-in credential, must NOT be logged · `[handoff-code-entry]` | C | `handoff-code-entry.test.tsx`: no network-error test |
| 11 | `src/components/booking/booking-flow.tsx:100` | T | up to three fetches (tier PUT, waitlist or registration POST) + `setPhase`. No router calls. No narrowing. | `classId`, `studentId`, `isFull` · `[booking-flow]` | C | `booking-flow.test.tsx`: no network-error test |
| 12 | `src/components/booking/booking-name-step.tsx:61` | T | fetch only (result assigned out). Already narrow. | none (`email` PII, names PII) · `[booking-name-step] profile request failed` | C | `booking-name-step.test.tsx:116` "surfaces a failure…" — no spy |
| 13 | `src/components/booking/booking-name-step.tsx:87` | T | resend fetch only. Already narrow. | `redirect` · `[booking-name-step] resend request failed` | C | no test reaches this catch |
| 14 | `src/components/booking/booking-name-step.tsx:107` | B | `resendRes.json()` probe → `null` → treated as not delivered (`expired-stuck`). Comment above (L102-103) explains `delivered`, not the catch; a disable reason is needed. (Could alternatively log, since a 200 with unreadable body is anomalous.) | — | C | none |
| 15 | `src/components/booking/booking-sign-in.tsx:40` | T | one of two fetches + `setStatus`. No narrowing. | `mode` (`email` PII) · `[booking-sign-in]` | C | `booking-sign-in.test.tsx`: no network-error test |
| 16 | `src/components/booking/join-as-student.tsx:35` | T | fetch + `router.refresh()` + `setTimeout`. Narrow: refresh after the try. | none · `[join-as-student]` | C | `join-as-student.test.tsx:65` — no spy |
| 17 | `src/components/class/add-walk-in.tsx:176` | T | fetch + five `setState` resets + `router.refresh()`. Narrow: refresh after the try (optional). | `classId` (`subject` holds names/email — PII) · `[add-walk-in]` | C | `add-walk-in.test.tsx`: no network test; its mocks `throw new Error('unexpected fetch …')` (L35,147,374,411,440), which this catch currently swallows as "Network error" — they will now log |
| 18 | `src/components/class/attendance-list.tsx:124` | T | fetch + `setAttendanceState` / `readErrorMessage` + `router.refresh()` on refusal. Narrow: refresh after the try (optional). | `registrationId`, `newStatus` · `[attendance-list]` | C | `attendance-list.test.tsx`: no network-error test |
| 19 | `src/components/class/cancel-class-button.tsx:37` | T | fetch + `router.refresh()` on success. Narrow: refresh after try. | `classId` · `[cancel-class-button]` | C | `cancel-class-button.test.tsx:117` — no spy |
| 20 | `src/components/class/complete-class-button.tsx:45` | T | fetch + `router.refresh()`. Narrow: refresh after try. | `classId` · `[complete-class-button]` | C | `complete-class-button.test.tsx:126` — no spy |
| 21 | `src/components/class/mark-unpaid-button.tsx:50` | T | fetch + `setDone` + `router.refresh()`. Narrow: refresh after try. | `paymentId` · `[mark-unpaid-button]` (or `[payment-mark-unpaid]` to match `use-payment-actions.ts`'s `[payment-*]`) | C | `mark-unpaid-button.test.tsx`: no network-error test |
| 22 | `src/components/class/publish-class-button.tsx:45` | T | fetch + `router.refresh()` in both branches. Narrow: refresh after try. | `classId` · `[publish-class-button]` | C | `publish-class-button.test.tsx:90` — no spy |
| 23 | `src/components/class/share-booking-link.tsx:23` | B | `navigator.share` dismissed → fall through to clipboard. Comment in catch. | — | C | — |
| 24 | `src/components/class/share-booking-link.tsx:31` | B | clipboard blocked → show URL. Comment in catch. | — | C | — |
| 25 | `src/components/layout/notification-list.tsx:89` | T | Show older: builds params, fetch, **deliberate `throw new Error('HTTP …')`** on `!res.ok` (after `router.refresh()` on 401), `res.json()`, `.map(reviveNotification)`, `mergeNotifications`, `setLoaded`/`setStatus`. The catch therefore also handles HTTP failures and revive/merge bugs. Logging is useful as-is; optionally move `router.refresh()` out, keep the rest. | `paging.audience`, `nextCursor` · `[notification-list] show older failed` | C | `notification-list.test.tsx:202`, `:218` (HTTP 500 → throw → this catch) — no spy; the describe with an `errorSpy` (L297-300) covers mark-read, not this catch |
| 26 | `src/components/settings/archive-room-button.tsx:41` | T | fetch + `router.push('/settings/rooms')`. Narrow: push after try. | `teacherRoomId`, `isArchived` · `[archive-room-button]` | C | `archive-room-button.test.tsx:112` — no spy |
| 27 | `src/components/settings/profile-form.tsx:104` | T | fetch + `setSuccess` + `router.refresh()`. Narrow: refresh after try. | `teacherId` (body fields incl. IBAN — PII) · `[profile-form]` | C | `profile-form.test.tsx:107` "reports a thrown fetch" — no spy (`afterEach` does `vi.restoreAllMocks()`) |
| 28 | `src/components/settings/share-room-button.tsx:112` | T | publish fetch + `router.refresh()` (success and on two codes) + `readError`. Narrow: refresh after try (optional). | `roomId` · `[share-room-button] share failed` | C | `share-room-button.test.tsx`: no rejection test for this handler (its L254 rejection hits `searchPublicRooms`, #66) |
| 29 | `src/components/settings/share-room-button.tsx:147` | T | switch fetch + `router.push` / `closePanel()` / `router.refresh()`. Narrow: move navigation/`closePanel` out (optional). | `teacherRoomId`, `sharedRoomId` · `[share-room-button] switch failed` | C | no rejection test |
| 30 | `src/components/settings/studio-template-form.tsx:266` | O | Shape-probe of an already-parsed 201 body (the fetch/`res.json()` is handled above with a logging catch). The try also wraps `anyBlocked`, `resumeStudioMessage`, `setSuccess`, `router.push` — a programming bug in any of them is silently routed into `!handled`, whose `console.warn(msg, rawJson)` omits the error. Recommend: narrow the try to the shape read (compute the outcome inside, act outside) or bind `err` and pass it to the existing warn. **Do not** switch to `console.error`: the `null`-payload path lands here by design. | — | C | `studio-template-form.test.tsx:569-572` asserts `errorSpy` not called and `warnSpy` called with exactly `(msg, null)`; L396/439/493 assert warn called / not called |
| 31 | `src/components/settings/template-form.tsx:223` | T | rooms load: fetch, `res.json()`, `setAllRoomsCount`, `.filter`, `setTeacherRooms`. No narrowing. The catch comment is history ("There was no `catch` here at all…") — rewrite per Comment Discipline when touching it. | `initialTeacherRoomId` · `[template-form] rooms load failed` | C | `template-form.test.tsx`: no thrown-rooms-fetch test (its throws at L1223/L1354 are the POST/PUT) |
| 32 | `src/components/settings/template-form.tsx:424` | O | Same shape as #30 (`anyBlocked`, `resumeMessage`, `setSuccess`, `router.push` inside the probe try). Same recommendation. | — | C | `template-form.test.tsx:1195-1199` asserts `errorSpy` not called and `warnSpy` `(msg, null)`; L954/1018/1094 |
| 33 | `src/components/settings/unlink-room-button.tsx:32` | T | fetch + `router.push` (two places). Narrow: push after try (optional). | `teacherRoomId` · `[unlink-room-button]` | C | `unlink-room-button.test.tsx:78` — no spy |
| 34 | `src/components/signup/page-address-field.tsx:105` | T | debounced slug-availability fetch + `res.json()` → `available = null` (unknown). Already narrow. No user-facing error, but state resets to "unknown". | `value` (the slug) · `[page-address-field] slug check failed` | C | `page-address-field.test.tsx`: no rejection test |
| 35 | `src/components/signup/profile-setup-form.tsx:41` | B | `localStorage.removeItem`. Comment in catch + docblock. | — | C | — |
| 36 | `src/components/signup/profile-setup-form.tsx:113` | B | `Intl…resolvedOptions().timeZone` feature detection. Docblock above explains. | — | C | — |
| 37 | `src/components/signup/profile-setup-form.tsx:197` | B | `localStorage.getItem` + `JSON.parse` draft read (also wraps `forgetDraft`/`setForm`, trivial). Comment in catch. | — | C | — |
| 38 | `src/components/signup/profile-setup-form.tsx:214` | B | `localStorage.setItem`. Comment in catch. | — | C | — |
| 39 | `src/components/signup/profile-setup-form.tsx:257` | T | fetch only (result assigned out). Already narrow. | `mode` (names/bio/email PII) · `[profile-setup-form]` | C | `profile-setup-form.test.tsx:316` "shows a network-error message…" — no spy |
| 40 | `src/components/signup/signup-form.tsx:51` | T | fetch + `readErrorMessage` + `setStatus`. No narrowing. | none (`email` PII) · `[signup-form]` | C | `signup-form.test.tsx:77` — no spy |
| 41 | `src/components/student/cancel-booking-button.tsx:58` | T | fetch + `router.refresh()` (two places) + `readError`. Narrow: refresh after try (optional). | `registrationId` · `[cancel-booking-button]` | C | `cancel-booking-button.test.tsx:93` — no spy |
| 42 | `src/components/student/pending-invitation-card.tsx:56` | T | fetch + `setDone` + `router.refresh()`. Narrow: refresh after try. | `invitationId`, `response` · `[pending-invitation-card]` | C | `pending-invitation-card.test.tsx`: no network-error test |
| 43 | `src/components/student/teacher-privacy-card.tsx:104` | T | fetch + `readError` + setters. No router. No narrowing. | `studentId`, `teacherId` (`values` are privacy choices — keep out) · `[teacher-privacy-card] save failed` | C | `teacher-privacy-card.test.tsx`: no network-error test |
| 44 | `src/components/student/teacher-privacy-card.tsx:146` | T | fetch + `readError` + `setUnlinked` + `router.refresh()`. Narrow: refresh after try. | `teacherId` · `[teacher-privacy-card] unlink failed` | C | no network-error test |
| 45 | `src/components/student/waitlist-entry-actions.tsx:38` | T | claim fetch + `router.refresh()`. Narrow: refresh after try. | `classId`, `entryId` · `[waitlist-entry-actions] claim failed` | C | `waitlist-entry-actions.test.tsx`: no network-error test |
| 46 | `src/components/student/waitlist-entry-actions.tsx:61` | T | leave fetch + `router.refresh()` (two places) + `readError`. Narrow: refresh after try. | `entryId` · `[waitlist-entry-actions] leave failed` | C | no network-error test |
| 47 | `src/components/students/archive-student-button.tsx:69` | T | `archivePatch()` (local helper that fetches) + `router.push('/students')`. Narrow: push after try. | `studentId` · `[archive-student-button] unarchive failed` | C | `archive-student-button.test.tsx`: no rejection test for unarchive |
| 48 | `src/components/students/archive-student-button.tsx:97` | T | `archivePatch()` + `router.push`, `closeConfirm()`, `router.refresh()`, `readError`. Narrow: navigation after try (optional). | `studentId`, `body?.waivePaymentIds.length` · `[archive-student-button] archive failed` | C | `archive-student-button.test.tsx:232`, `:396` — no spy |
| 49 | `src/components/students/contact-form.tsx:77` | T | (`ContactForm`) fetch + `router.refresh()`. Narrow: refresh after try. | `invitationId` (payload names/email PII) · `[contact-form]` | C | `contact-form.test.tsx`: no rejection test in the `ContactForm` describe |
| 50 | `src/components/students/contact-form.tsx:158` | T | (`ArchiveContactButton`) fetch + `router.push('/students')`. Narrow: push after try. | `invitationId`, `isArchived` · `[archive-contact-button]` | C | `contact-form.test.tsx:211` — no spy |
| 51 | `src/components/students/contact-form.tsx:209` | T | (`ResendInvitationButton`) fetch + `router.refresh()`. Narrow: refresh after try. | `invitationId` · `[resend-invitation-button]` | C | `contact-form.test.tsx:278` — no spy |
| 52 | `src/components/students/contact-list.tsx:103` | T | list fetch, `window.location.href = '/login'` on 401, `res.json()`, `.filter(isContact)`, setters. Trivial; no narrowing. Catch comment is partly history ("used to propagate…"). | `archived` · `[contact-list]` | C | `contact-list.test.tsx:161` — no spy |
| 53 | `src/components/students/create-student-form.tsx:103` | T | fetch + `readErrorMessage` + `setInvitedEmail`. No narrowing. | none (payload names/email PII) · `[create-student-form]` | C | `create-student-form.test.tsx`: no rejection test (L179 spy is the unreadable-body test) |
| 54 | `src/components/students/remove-student-button.tsx:46` | T | fetch + `router.push` (two places) + `readError`. Narrow: push after try (optional). | `invitationId` · `[remove-student-button]` | C | `remove-student-button.test.tsx`: no network-error test |
| 55 | `src/components/studio-class/cancel-studio-class-button.tsx:37` | T | fetch + `router.refresh()`. Narrow: refresh after try. | `studioClassId` · `[cancel-studio-class-button]` | C | `cancel-studio-class-button.test.tsx:54` — no spy |
| 56 | `src/components/studio-class/delete-studio-class-button.tsx:80` | T | fetch + `readError` + flag only; `window.location.assign` already outside the try. Already narrow. | `studioClassId` · `[delete-studio-class-button]` | C | `delete-studio-class-button.test.tsx:148` — no spy |
| 57 | `src/components/studio-class/restore-studio-class-button.tsx:30` | T | fetch + `router.refresh()`. Narrow: refresh after try. | `studioClassId` · `[restore-studio-class-button]` | C | `restore-studio-class-button.test.tsx:69` — no spy |
| 58 | `src/components/studio-class/student-count-editor.tsx:42` | T | fetch + `setSuccess` + `router.refresh()`. Narrow: refresh after try. | `studioClassId` · `[student-count-editor]` | C | `student-count-editor.test.tsx:67` — no spy |
| 59 | `src/lib/api-utils.ts:151` | B | `request.json()` parse → 400 "Invalid JSON". No comment (self-evident). | — | S (API helper) | — |
| 60 | `src/lib/finish-window.ts:58` | L | `log.error({ timeZone }, 'invalid timezone…')`, UTC fallback. Binding `err` would add it to the object. | — | S (imports pino `log`; no `'use client'` importer) | `finish-window.test.ts:75` asserts `toHaveBeenCalledWith({ timeZone: 'Not/AZone' }, …)` exactly — would need `objectContaining` |
| 61 | `src/lib/iana-timezone.ts:32` | B | `Intl.DateTimeFormat` zone validation probe. Docblock explains. | — | shared; reaches client bundles via `lib/schemas.ts` and `lib/timezone-options.ts` (e.g. `profile-form.tsx`) | — |
| 62 | `src/lib/migration-policy.ts:131` | B | `git merge-base` candidate probing. Comment "try the next candidate". | — | S (tooling) | — |
| 63 | `src/lib/migration-policy.ts:152` | B | reading/parsing `GITHUB_EVENT_PATH`. Comment. | — | S (tooling) | — |
| 64 | `src/lib/migration-policy.ts:160` | B | `git rev-parse` of `GITHUB_BEFORE`. Comment. | — | S (tooling) | — |
| 65 | `src/lib/migration-policy.ts:177` | B | local merge-base candidate probing. Comment. | — | S (tooling) | — |
| 66 | `src/lib/room-search.ts:90` | T | fetch only (comment: "Only the request itself is wrapped"). Returns `{ reason: 'network' }`; callers render the message. Log in the helper, not the callers. | none needed (postcode/street are a venue address; optional) · `[room-search] request failed` | shared; imported by `'use client'` `room-search-step.tsx`, `share-room-button.tsx` | `room-search.test.ts:55` (unit), `share-room-button.test.tsx:253`, `add-room-flow.test.tsx:300` — no spy |
| 67 | `src/lib/room-search.ts:104` | T | `res.json()` on an ok response → `'network'` (comment above explains). Body read = transport-ish; log like #66. | · `[room-search] response unreadable` | same as #66 | `room-search.test.ts:68` (table incl. `SyntaxError`) — no spy |
| 68 | `src/lib/timezone.ts:111` | L | `startOfLocalDay` invalid-zone fallback, `log.error({ timeZone }, …)`. | — | S (pino `log`; no `'use client'` importer) | `timezone.test.ts:66-69` uses `objectContaining` — safe to add `err` |
| 69 | `src/lib/timezone.ts:218` | L | `formatInstantInZone` fallback, `log.error({ timeZone }, …)`. | — | S | `timezone.test.ts:485` `toHaveBeenCalled()` — safe |
| 70 | `src/lib/timezone.ts:308` | L | `classStartInstant` fallback, `log.error({ timeZone }, …)`. | — | S | `timezone.test.ts:152-155` `objectContaining` — safe |
| 71 | `src/lib/visual-baseline-freshness.ts:196` | B | attestation file absent/unreadable → `{}` (fails closed). Comment. | — | S (tooling) | — |
| 72 | `src/lib/visual-baseline-freshness.ts:221` | B | hashing a missing file → not attested (fails closed). No comment in catch. | — | S (tooling) | — |
| 73 | `src/lib/worktree/reap.ts:32` | B | `sanitizeSlug` throws on a name that can't sanitize → "not a match". Docblock explains. | — | S (tooling) | — |
| 74 | `src/lib/worktree/registry.ts:200` | B | `JSON.parse` probe → `null`. No comment (self-evident). | — | S (tooling) | — |
| 75 | `src/lib/worktree/registry.ts:288` | B | `statSync` of lock dir fails → `{ stale: false }`. No comment in catch (L283 comment covers the step). | — | S (tooling) | — |
| 76 | `src/lib/worktree/registry.ts:339` | B | restore-rename failed → `rmSync` fallback. Comment above (L334-336). | — | S (tooling) | — |
| 77 | `src/lib/worktree/registry.ts:519` | B | release-lock errors ignored. Comment in catch. | — | S (tooling) | — |
| 78 | `src/lib/worktree/registry.ts:585` | B | tmp cleanup inside a catch that rethrows `writeErr`. Comment in catch. | — | S (tooling) | — |

## Summary counts (from the table rows)

- **T** rows: #1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 25, 26, 27, 28, 29, 31, 33, 34, 39, 40, 41–58 (18 rows), 66, 67 → 2 + 8 + 8 + 5 + 1 + 2 + 2 + 18 + 2 = **48**
- **B** rows: #3, 4, 5, 14, 23, 24, 35, 36, 37, 38, 59, 61, 62, 63, 64, 65, 71–78 (8 rows) → 3 + 1 + 2 + 4 + 1 + 1 + 4 + 8 = **24**
- **L** rows: #60, 68, 69, 70 → **4**
- **O** rows: #30, 32 → **2**
- Total: 48 + 24 + 4 + 2 = **78** ✓

Within the proposed lint scope (`src/components` + `src/app`, rows #1–#58): T 46 (48 − #66, #67), B 10 (#3, 4, 5, 14, 23, 24, 35–38), O 2 → 46 + 10 + 2 = 58 ✓. The 10 B rows there need `eslint-disable-next-line` with a reason; 6 of them already carry an explanatory comment in or directly above the catch (#4, 23, 24, 35, 37, 38) and #3/#36 have one nearby; #5 and #14 have none.

Narrowing: of the 48 T rows, 29 (#7, 8, 16–22, 25–29, 33, 41, 42, 44–51, 54, 55, 57, 58) have `router.push`/`router.refresh` (or `closePanel`) inside the try where moving navigation after the try is recommended (optional where marked). Only #6 wraps non-trivial non-router work (DOM download). #25 deliberately throws on HTTP failure into the same catch.

PII caution for log context: #1, 10 (magic-link code), 12, 15, 17, 27, 39, 40, 43, 49, 53 have email/names/credential/privacy/IBAN values in scope that must stay out of the log object.

Test impact: nothing fails on stray `console.error`. Tests that break on conversion are the exact-argument assertions at `studio-template-form.test.tsx:569-572`, `template-form.test.tsx:1195-1199` (only if #30/#32 are changed to log) and `finish-window.test.ts:75` (only if #60 adds `err`). 24 T rows (#2, 9, 12, 16, 19, 20, 22, 25, 26, 27, 33, 39, 40, 41, 48, 50, 51, 52, 55, 56, 57, 58, 66, 67) have tests that reach the catch without a `console.error` spy and would print to stderr; the convention elsewhere (e.g. `room-settings-step.test.tsx:100-110`) is to spy and assert the tagged log.
