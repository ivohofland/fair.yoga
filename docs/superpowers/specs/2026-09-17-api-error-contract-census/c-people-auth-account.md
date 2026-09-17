# Census C: account, auth, invitations, students, teacher-links, teachers, notifications-read

> **Record, not reference.** A subagent census taken for the #197 spec
> (`../2026-09-17-api-error-contract-design.md`) by reading the tree at
> `4e1ec6e4`. Line numbers are as of that commit. **The account rows
> predate #623** (multiple profiles per account, live-only unique index on
> `accountId`), which landed on `main` before this branch was cut; the
> spec's §1 says which findings that retires.

Paths are repo-relative. Nothing was executed against a running app. Every retry and reachability claim comes from reading the code, and a claim I could not settle that way is marked UNKNOWN.

"Mutating pairs" means every exported POST/PUT/PATCH/DELETE in the group's route files: **26 pairs**. Three GET handlers are excluded: `auth/session` GET, `students` GET, and `students/[id]` GET. The `privacy` and `teachers/[id]` files also export GETs, and those are excluded too.

Short names used in the tables:
`R:acct` = `src/app/api/account/route.ts` · `R:inv` = `src/app/api/invitations/[id]/route.ts` · `S:inv` = `src/app/api/invitations/[id]/shared.ts` · `svc:inv` = `src/services/invitations.ts` · `T:inv` = `tests/integration/invitations-api.test.ts` · `T:acct` = `tests/integration/account-api.test.ts` · `T:stu` = `tests/integration/students-api.test.ts` · `T:tsu` = `tests/integration/teacher-signup-api.test.ts`

Out-of-scope responses are counted by distinct response kind: the `requireX` 401/403s, `parseBody` "Invalid JSON" plus schema 400, 429s, and input-shape 400s. Two more kinds are counted as auth rather than state and are named where they occur: a 403 from comparing `session.xId !== id`, which reads no stored row, and "No valid fields to update".

---

## 1. DELETE /api/account

**A. Callers:** `src/components/account/data-and-deletion.tsx:53`. It reads errors with `readErrorMessage` and shows them as red text (`role=alert text-danger`, :111).

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| A1 | 503 | `Your student data was removed. ${billed} The system was busy and could not remove the rest of your teaching data. Wait a moment, then press Delete again to finish.` (`billed` = R:acct:72) | PARTIAL_ERASURE_BUSY | R:acct:76 | R:acct:75 | GENUINE (lock race; teacher half not erased) | USER | none |
| A2 | 500 | `Your student data was removed. ${billed} Removing the rest of your teaching data failed. Pressing Delete again will not fix it — please contact support.` | PARTIAL_ERASURE | R:acct:81 | R:acct:80 | GENUINE | USER | T:acct:416-418 (status + code) |
| A3 | 503 | `The system was busy and could not remove your account. ${stateNote} Wait a moment, then press Delete again.` (`stateNote` = R:acct:88-91) | ERASURE_BUSY | R:acct:94 | R:acct:93 | GENUINE (lock race / `ErasureLockSetError`) | USER | T:acct:625-628, :731-734 (status + code + prose `/again/`) |
| A4 | 500 | `Removing your account failed. ${stateNote} Pressing Delete again will not fix it — please contact support.` | ERASURE_FAILED | R:acct:99 | R:acct:98 | GENUINE | USER | T:acct:478-493 (status + code + prose: "will not fix it", "contact support", "Nothing was changed"); :538-545 (status + code + prose: not "Nothing was changed", "closed and billed") |

These four are failure and contention states, not domain refusals. They are included because the route builds them on purpose, with codes. A concurrent duplicate that loses deliberately answers **200**, not an error (`AlreadyErasedError`, R:acct:146, :180).

**C. Sequential retry:** once the erasure has committed, `validateSession` finds no live profile and deletes the session (`src/lib/auth/session.ts:84-88`). The first response also cleared the cookie (R:acct:219). The retry therefore gets a **401** from `requireSession`, which is out of scope. After an A2 or A1 (a partial erasure), a retry is not a repeat of a committed success: it finishes the teacher half, as T:acct:351 shows.

**Out of scope:** 2 (the two 401s).

---

## 2. POST /api/account/onboarding

**A. Callers:** `src/components/schedule/onboarding-skip-button.tsx:40`. It ignores the body and only calls `console.error`. There is no UI for a failure; the button just re-enables.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| B1 | 409 | `The checklist is not settled yet` | ONBOARDING_NOT_SETTLED | onboarding/route.ts:41 | onboarding/route.ts:41 | GENUINE | DEV? ("settled" is the code's own term, from `isSettled`; no user ever sees this string) | T:tsu:844-847 (status + code) |

**C. Sequential retry:** **200**, idempotent. The `updateMany` carries a `NOT has` guard (onboarding/route.ts:47-50), and `isSettled` does not depend on `share` (`src/lib/onboarding.ts:85-87`).

**Out of scope:** 5 (401 ×2, 403, Invalid JSON, schema 400).

---

## 3. POST /api/account/student-profile

**A. Callers:**
- `src/components/booking/join-as-student.tsx:23`: uses `readErrorMessage`. **Any 409 counts as success** because the check is on status, not code (:26); the client then refreshes. Any other error shows as red text.
- `src/components/account/set-up-student-side.tsx:19`: uses `readError`. Only a 409 with code `ALREADY_STUDENT` counts as success and navigates. Anything else shows as red text.
- `src/components/booking/booking-name-step.tsx:53`: custom handling. A 401 triggers a resend via student-signup and shows a neutral `role=status` caption. Any other failure goes through `readErrorMessage` and shows as red text (:162-165).

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| C1 | 409 | `Account already has a student profile` | ALREADY_STUDENT | student-profile/route.ts:50 (pre-check on `session.studentId`) | :49-52 | ALREADY | DEV? ("student profile" is the data-model term; the UI says "student side") | T:acct:84-89 (status + code); `tests/integration/student-profile-ticket.test.ts:108` (status only) |
| C2 | 409 | `Account has no profile to copy from` | NO_PROFILE_SOURCE | :63 | :62-65 | GENUINE (unreachable: an invariant guard, per the comment at :54-60) | DEV? (describes the implementation) | none (the comment says why) |
| C3 | 409 | `Account already has a student profile` | ALREADY_STUDENT | :140 (unique conflict on `accountId`) | :139-142 | BOTH: ALREADY when a concurrent double-tap loses; GENUINE for an account whose student half is **erased** while its teacher half is live (see Summary, surprise 2) | DEV? (same as C1) | T:acct:966-1011 (status + code + exact message; the test does not pin whether C3 or C5 fires) |
| C4 | 409 | `This email now has an account. Please sign in and add a student profile.` | ACCOUNT_EXISTS | :154 | :153-157 | GENUINE (ticket path; another account took the address during the ticket window) | USER | `student-profile-ticket.test.ts:204-207` (status + code) |
| C5 | 409 | `Account already has a student profile` | ALREADY_STUDENT | :160 (unique conflict on `email`, session path) | :159-162 | ALREADY (concurrent double-tap only) | DEV? (same as C1) | T:acct:1010-1011 (either C3 or C5) |

**C. Sequential retry:** on the session path, the retry gets **409 ALREADY_STUDENT** (C1, :48-53). On the ticket path with the original cookies, the ticket is already spent, so the request falls through (`src/lib/auth/profile-authorization.ts:102-116`) to a **401**, which is out of scope. With the cookies the success response set (session, ticket cleared at :191), the retry hits C1.

**Out of scope:** 4 (401 ×2, Invalid JSON, schema 400).

---

## 4. POST /api/account/teacher-profile

**A. Callers:** `src/components/signup/profile-setup-form.tsx:235`. Custom parse of `body.error.code`:
- 401 in session mode: navigates to `/login`.
- 401 in ticket mode: resends via teacher-signup and shows a neutral caption.
- `ALREADY_TEACHER`: shows a neutral settled panel ("You already teach here", or `AlreadyTeachingPanel`).
- `SLUG_TAKEN`: shows the **client's own** field error, "That address is taken — please pick another." The server message is not shown.
- Anything else: `error.message` as red text (:404-407).

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| D1 | 409 | `Account already has a teacher profile` | ALREADY_TEACHER | teacher-profile/route.ts:39 (session pre-check) | :38-41 | ALREADY | DEV? ("teacher profile" is the model term; the UI says "teacher page") | T:tsu:967-970 (status + code); `tests/integration/teacher-profile-precedence.test.ts:101` (status only) |
| D2 | 409 | `Page address already in use` | SLUG_TAKEN | :66 | :66, :79 | BOTH: GENUINE when another teacher holds the slug; ALREADY on a session-path double-tap whose loser collides on `pageSlug` before `accountId` (by reading, not measured) | USER | T:tsu:643-644, :667-668, :727-731 (status + code); `teacher-profile-precedence.test.ts:157-158` (status + code) |
| D3 | 409 | `Account already has a teacher profile` | ALREADY_TEACHER | :83 (unique conflict on `email` or `accountId`) | :82-85 | BOTH: ALREADY on a session double-tap; GENUINE on the ticket path when an `Account.email` collision occurs (an account appeared during the ticket window, possibly student-only; see surprise 3) | DEV? (same as D1) | none |

**C. Sequential retry:** on the session path, **409 ALREADY_TEACHER** (D1). On the ticket path with the original cookies, **401**, out of scope (`T:tsu:610-628`, "refuses a spent ticket"). With the updated cookies, D1.

**Out of scope:** 4 (401 ×2, Invalid JSON, schema 400; `parseBody` has two call sites).

---

## 5. POST /api/auth/magic-link/claim

**A. Callers:** `src/components/auth/handoff-code-entry.tsx:33`. It uses `readErrorMessage` and shows red text (:80-83).

**B.** Responses are **uniform by design** for a wrong code, an unknown code, and a spent budget (claim/route.ts:52-53).

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| E1 | 400 | `That code did not work. Ask for a new link.` | — | claim/route.ts:54 | :54 | BOTH: ALREADY once the token row is consumed by the first claim (`src/lib/auth/magic-link.ts:81`) or the origin cookie is cleared (:112); GENUINE for a wrong code or spent budget. Uniform by design, so not graded further | USER | `tests/integration/magic-link-claim.test.ts:194` (status only) |
| E2 | 400 | `Account not found` | — | :88 | :88 | GENUINE | DEV? ("Account" is the model name; it is a state reported as a 400) | none |

**C. Sequential retry:** **400 E1**. The token row was deleted on the first claim, so `claimWithCode` finds no candidates (`src/lib/auth/handoff.ts:122`, :141).

**Out of scope:** 3 (429, Invalid JSON, schema 400).

---

## 6. POST /api/auth/magic-link/send

**A. Callers:**
- `src/app/(public)/login/page.tsx:18`: ignores the body. Any failure shows fixed red copy, "Something went wrong. Please try again.", so a 429's retry time is never shown.
- `src/components/booking/booking-sign-in.tsx:34`: same behaviour.

**B.** None. The route answers a **uniform 200 by design** so account existence is not leaked (send/route.ts:40-44, :54-59), and it swallows delivery failures.

**C. Sequential retry:** **200**, and **another email is sent** (a duplicate side effect) until the per-address limit of 3 per 15 minutes returns a 429 (send/route.ts:37-38).

**Out of scope:** 4 (429 ×2 sites, Invalid JSON, schema 400).

---

## 7. POST /api/auth/magic-link/verify

**A. Callers:** `src/app/(public)/verify/page.tsx:626`. It checks status only (`VerifyResponseError`) and **never reads the error body**. On failure it probes GET `/api/auth/session`:
- signed in: neutral "already signed in" state;
- otherwise: `ErrorState`, fixed copy with a red "Verification failed" label (:233-236);
- non-400 failures are also logged to the console.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| F1 | 400 (`MAGIC_LINK_REFUSED_STATUS`, `src/lib/schemas.ts:140`) | `Invalid or expired magic link` | — | verify/route.ts:48 | :48 | BOTH: ALREADY once a same-browser verify has consumed the token (`handoff.ts:35-36`); GENUINE for an expired or unknown token, or a pre-origin token | DEV (starts "Invalid …"; the client never shows it) | none found at route level |
| F2 | 400 (same constant) | `Account not found` | — | :96 | :96 | GENUINE. Also reached by a `student_signup` token with a missing or unsafe redirect, via `signupTicketFor` → null (`src/lib/auth/signup-ticket.ts:176-186`) | DEV? (model name) | `src/app/api/auth/magic-link/verify/account-not-found.test.ts:94-97` (status + exact message; mocked unit); T:tsu:518 (status only); `tests/integration/student-signup-verify.test.ts:93`, `:106` (status only) |

**C. Sequential retry:** **400 F1**, because the token row is gone (`magic-link.ts:81`, `handoff.ts:35-36`). The page turns this into "already signed in" when a session exists.

**Out of scope:** 2 (Invalid JSON, schema 400).

---

## 8. POST /api/auth/passkey/authenticate/options

**A. Callers:** `src/components/booking/passkey-sign-in.tsx:23`. A 429 gets a custom parse of `error.message` and shows red text. Any other failure throws, and the component shows its fixed red `DEFAULT_ERROR_MESSAGE`.

**B.** None. The route reads nothing but the caller's IP (docblock :10-25).

**C. Sequential retry:** **200** with a fresh challenge (route.ts:41-48).

**Out of scope:** 1 (429).

---

## 9. POST /api/auth/passkey/authenticate/verify

**A. Callers:** `src/components/booking/passkey-sign-in.tsx:41`. It ignores the body. Any failure throws, and the component shows the fixed red "Passkey sign-in didn't work here — use the email link instead."

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| G1 | 400 | `Invalid or expired challenge` | — | authenticate/verify/route.ts:21 | :21 | BOTH: ALREADY because the challenge is deleted on first use (`src/lib/auth/passkey.ts:130-141`); GENUINE when it expired, was evicted, or was never issued | DEV ("Invalid …", protocol jargon) | `tests/integration/passkey-api.test.ts:37-38` (status + substring `challenge`) |
| G2 | 400 | `Credential not found` | — | :30 | :30 | GENUINE (the passkey row is gone; erasure deletes them, `src/services/gdpr.ts:700`, :1433) | DEV? (`PasskeyCredential` model / WebAuthn term) | none |
| G3 | 400 | `Authentication verification failed` | — | :41 | :41 | GENUINE (depends on the stored `publicKey` and `counter`; borderline input-shape) | DEV? | none |

UNKNOWN: whether `@simplewebauthn/server` returns `verified: false` or throws for a given mismatch. A throw would reach `classifyApiError`'s generic 500 instead of G3. This was not measured.

**C. Sequential retry:** **400 G1**, because the challenge was consumed.

**Out of scope:** 2 (Invalid JSON, schema 400).

---

## 10. POST /api/auth/passkey/register/options

**A. Callers:** `src/components/account/add-passkey.tsx:17`. It ignores the body. Any failure throws, and the component shows the fixed red "Could not add a passkey on this device."

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| H1 | 404 | `Account not found` | — | register/options/route.ts:27 | :27 | GENUINE (practically unreachable: `validateSession` already resolved the account, `session.ts:75-89`) | DEV? (model name) | none |
| H2 | 404 | `Account has no profile` | — | :31 | :31 | GENUINE (practically unreachable: the session requires a live profile, and this select does not filter `deletedAt`) | DEV? | none |

**C. Sequential retry:** **200** with new options. The stored challenge is replaced (`passkey.ts:112`, :123, :212).

**Out of scope:** 2 (401 ×2).

---

## 11. POST /api/auth/passkey/register/verify

**A. Callers:** `src/components/account/add-passkey.tsx:23`. It ignores the body and shows the same fixed red copy as pair 10.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| I1 | 400 | `No pending registration challenge` | — | register/verify/route.ts:24 | :24 | BOTH: ALREADY because the challenge was consumed at :22 by the committed first call; GENUINE when options were never requested or the challenge expired | DEV? (WebAuthn jargon) | none |
| I2 | 400 | `Registration verification failed` | — | :33 | :33 | GENUINE (borderline input-shape) | DEV? | none |

A duplicate `credentialId` would throw P2002 at :36, which lands in the generic code-less 409 from `classifyApiError`. That path is not deliberate and is not tabled.

**C. Sequential retry:** **400 I1**. No duplicate credential is written.

**Out of scope:** 4 (401 ×2, Invalid JSON, schema 400).

---

## 12. DELETE /api/auth/session

**A. Callers:** `src/components/account/sign-out-button.tsx:26`. It ignores the body. A failed request or a network error shows the fixed red caption "Couldn't sign out — try again." and navigates away anyway. The `/api/auth/session` call at `verify/page.tsx:698` is a GET, so it is not a caller of this pair.

**B.** None. `invalidateSession` errors are swallowed (session/route.ts:30-34).

**C. Sequential retry:** **200**, idempotent (session/route.ts:29-40).

**Out of scope:** 0.

---

## 13. POST /api/auth/student-signup

**A. Callers:**
- `src/components/booking/booking-sign-in.tsx:29`: ignores the body. Any failure shows fixed red "Something went wrong. Please try again." **A 200 always shows "Check your inbox", even when the body says `delivered: false`.**
- `src/components/booking/booking-name-step.tsx:82`, the resend after a 401: a failure goes through `readErrorMessage` into a **neutral** `role=status` caption; a 200 reads `data.delivered`.

**B.** None. The route answers a **uniform 200 by design** (docblock :10-17). A delivery failure is still a 200, reported as `delivered: false` (:59-75).

**C. Sequential retry:** **200**, and another email goes out (a duplicate side effect) until the per-address limit of 3 per 15 minutes returns a 429 (:32-36).

**Out of scope:** 4 (429 ×2, Invalid JSON, schema 400).

---

## 14. POST /api/auth/teacher-signup

**A. Callers:**
- `src/components/signup/signup-form.tsx:40`: uses `readErrorMessage` and shows red text.
- `src/components/signup/profile-setup-form.tsx:283`: calls `.then(r => r.ok)` and ignores the body. It then shows a neutral caption, either `expired` or `expired-stuck` (:397-402).

**B.** None. The route answers a **uniform 200 by design** (docblock :9-15), and delivery failures are swallowed (:50-55). Unlike student-signup, it returns no `delivered` flag.

**C. Sequential retry:** **200**, and another email goes out until the 3-per-15-minutes limit returns a 429 (:27-28).

**Out of scope:** 4 (429 ×2, Invalid JSON, schema 400).

---

## 15. PUT /api/invitations/[id]

**A. Callers:** `src/components/students/contact-form.tsx:61`. It uses `readErrorMessage` and shows red text (`text-danger`, no role, :95).

**B.** The post-CAS rows come from `casMatchedNothing`, called at R:inv:265 with scope `'pending'`.

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| J1 | 404 | `Contact not found` | — | S:inv:47 | R:inv:152 | GENUINE | USER | T:inv:558 (status only) |
| J2 | 409 | `This person declined. You can archive this contact, but it cannot be removed.` | DECLINED_IS_PERMANENT | S:inv:56-59 | R:inv:158 | GENUINE | USER (the wording is about removal, but this action is an edit) | T:inv:432-433 (status + code) |
| J3 | 409 | `This person already accepted your invitation — they are now on your Students list. Reload to see them.` | NOT_PENDING | S:inv:68-71 | R:inv:168 | GENUINE | USER (the claim can be false; surprise 7) | T:inv:465-466, :502-503, :4035-4037 (status + code) |
| J4 | 409 | `Another of your contacts already uses this email address.` | ALREADY_INVITED | R:inv:256 | R:inv:255-259 | GENUINE (another row holds the address) | USER | T:inv:534-537 (status + code + exact message) |
| J5 | 404 | `Contact not found` | — | S:inv:47 | R:inv:94 | GENUINE (row deleted mid-request) | USER | `src/app/api/invitations/[id]/cas-scope.test.ts:93-95` (status + exact message; mocked) |
| J6 | 409 | (same as J2) | DECLINED_IS_PERMANENT | S:inv:56-59 | R:inv:95 | GENUINE (declined mid-request) | USER | T:inv:3763-3764 (status + code) |
| J7 | 409 | (same as J3) | NOT_PENDING | S:inv:68-71 | R:inv:109 | GENUINE (accepted mid-request) | USER | T:inv:3907-3908 (status + code) |
| J8 | 409 | `This contact changed while you were working on it. Reload and try again.` | — | R:inv:122 | R:inv:121 | GENUINE (the re-read is `'unread'`, or the row is back to `pending`) | USER | `cas-scope.test.ts:137-142` (status + no code + exact message; mocked) |

**C. Sequential retry:** **200**, idempotent. The same data is written again, and `readdressed` is false because the email already equals the stored one (R:inv:190, :211-252).

**Out of scope:** 6 (401 ×2, 403, Invalid JSON, schema 400, "No valid fields to update" at R:inv:178).

---

## 16. DELETE /api/invitations/[id]

**A. Callers:** `src/components/students/remove-student-button.tsx:33`. It uses `readErrorMessage` and shows red text. On success it navigates away.

**B.** The post-CAS rows come from `casMatchedNothing`, called at R:inv:299 with scope `'not-declined'`. `NOT_PENDING` cannot come back on this path (R:inv:104).

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| K1 | 404 | `Contact not found` | — | S:inv:47 | R:inv:278 | BOTH: ALREADY on the sequential retry after a committed delete; GENUINE for another teacher's id or an unknown id | USER | T:inv:328 (status only; another teacher's row) |
| K2 | 409 | `This person declined. You can archive this contact, but it cannot be removed.` | DECLINED_IS_PERMANENT | S:inv:56-59 | R:inv:285 | GENUINE | USER | T:inv:301-302 (status + code) |
| K3 | 404 | `Contact not found` | — | S:inv:47 | R:inv:94 | ALREADY (the row vanished mid-request: a concurrent duplicate or another tab) | USER | T:inv:3814-3815 (status + code is undefined) |
| K4 | 409 | (same as K2) | DECLINED_IS_PERMANENT | S:inv:56-59 | R:inv:95 | GENUINE | USER | T:inv:3710-3711 (status + code) |
| K5 | 409 | `This contact changed while you were working on it. Reload and try again.` | — | R:inv:122 | R:inv:121 | GENUINE (re-read finds `accepted` or `pending`, or is `'unread'`) | USER | `cas-scope.test.ts:111-116`, `:151-156` (status + no code + exact message; mocked) |

**C. Sequential retry:** **404 K1** from the pre-check (R:inv:277-278). The retry does not get a 2xx.

**Out of scope:** 3 (401 ×2, 403).

---

## 17. PATCH /api/invitations/[id]

**A. Callers:** `src/components/students/contact-form.tsx:146` (`ArchiveContactButton`). It uses `readErrorMessage` and shows red text.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| L1 | 404 | `Contact not found` | — | S:inv:47 | R:inv:320 | GENUINE | USER | T:inv:634 (status only) |

A row deleted between the read and `update` at R:inv:337 would throw P2025 and fall to the generic fallback. That path is not deliberate and is not tabled.

**C. Sequential retry:** **200** with `action: 'unchanged'` (R:inv:326-328; T:inv:643-669).

**Out of scope:** 4 (401 ×2, 403, 400 "A state of archived or unarchived is required" at :315).

---

## 18. POST /api/invitations/[id]/resend

**A. Callers:** `src/components/students/contact-form.tsx:204`. It uses `readErrorMessage` and shows red text.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| M1 | 404 | `Contact not found` | — | S:inv:47 | resend/route.ts:73 | GENUINE | USER | T:inv:707 (status only) |
| M2 | 409 | `This person declined. You can archive this contact, but it cannot be removed.` | DECLINED_IS_PERMANENT | S:inv:56-59 | resend/route.ts:75 | GENUINE | USER (the wording is about removal, but this action is a resend) | T:inv:724-725 (status + code) |
| M3 | 409 | `This person already accepted your invitation — they are now on your Students list. Reload to see them.` | NOT_PENDING | S:inv:68-71 | resend/route.ts:82 | GENUINE | USER | T:inv:739-740 (status + code) |
| M4 | 404 | `Contact not found` | — | S:inv:47 | resend/route.ts:101 (marker `updateMany` count 0) | GENUINE (deleted mid-request) | USER | T:inv:1172 (status only) |

**C. Sequential retry:** **200**. The marker is rewritten and `deliverInvitation` fires again, which is a duplicate delivery attempt (the #622 cap applies to teacher-inbox recipients). This continues until the shared student-write bucket returns a 429 (resend/route.ts:66-70, :97-116).

**Out of scope:** 4 (401 ×2, 403, 429).

---

## 19. POST /api/invitations/[id]/respond

**A. Callers:** `src/components/student/pending-invitation-card.tsx:36`. It uses `readErrorMessage` and shows a red caption (:146). On success it switches to a neutral `SettledNotice`, which blocks a second POST.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| N1 | 404 | `Invitation not found` | — | reason at svc:inv:1221, :1229 (accept, including a blocked pending row), :1387 (decline) | respond/route.ts:48 | GENUINE | DEV (names the `Invitation` model, per the brief's rule) | T:inv:1407, :1448, :1529, :1567 (status only) |
| N2 | 409 | `This account has been deleted` | — | reason at svc:inv:1355 (from `StudentErasedError`, `src/lib/db-locks.ts:335`) | respond/route.ts:50 | GENUINE (accept only; a concurrent erasure, since a sequential session no longer resolves `studentId`) | USER | no HTTP test; service-level only: `src/services/invitations-lock-order.test.ts:1943` (reason) |
| N3 | 409 | `This invitation has already been answered` | ALREADY_ANSWERED | reason `NOT_PENDING` at svc:inv:1230, :1325/:1351 (via :1356), :1403 | respond/route.ts:52 | BOTH: ALREADY for a repeated **decline**; GENUINE for an accept on a declined or blocked row, or a decline on an accepted row | USER | T:inv:1393-1394 (status + code; accept on declined); T:inv:1574-1575 (status + code; second decline, the ALREADY case) |

**C. Sequential retry:**
- **accept:** **200**, idempotent. `linkTeacherStudent` skips duplicates, and when the CAS misses, the re-read finds `accepted` and treats it as success (svc:inv:1321-1325).
- **decline:** **409 N3**. The CAS matches 0 rows (svc:inv:1396-1403).

**Out of scope:** 5 (401 ×2, 403, Invalid JSON, schema 400).

---

## 20. POST /api/students

**A. Callers:** `src/components/students/create-student-form.tsx:81`. It parses `json.error?.message` itself and shows red text (:167). `res.json()` is not wrapped in a catch, so a non-JSON error body shows as "Network error".

**B.** All four rows are relayed by one call, `respondError(REFUSAL_MESSAGES[result.reason], 409, result.reason)` at `src/app/api/students/route.ts:100`.

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| O1 | 409 | `You have already invited this person — open their contact to resend or update their details.` | ALREADY_INVITED | msg svc:inv:81; reason :272 (pending pre-check), :362 (create race) | students/route.ts:100 | ALREADY (a pending row for the address means the invite exists; the same answer for blocked and fresh addresses, by design) | USER | T:stu:285-296 (status + code + substring `resend`); T:stu:1682-1686 (status + code + exact message); T:stu:1551 (status only, 48 sequential repeats); T:inv:1870-1872 (code, repeat POST) |
| O2 | 409 | `This person is already one of your students.` | ALREADY_LINKED | msg svc:inv:82; reason :309 | :100 | GENUINE | USER | T:stu:399-401, :440-442 (status + code); T:inv:2095-2096 (status + code) |
| O3 | 409 | `This person declined your invitation.` | DECLINED | msg svc:inv:83; reason :271 | :100 | GENUINE | USER | T:inv:317-318, :1383-1384, :1905-1906 (status + code) |
| O4 | 409 | `This contact changed while you were sending — reload and try again.` | CONTACT_CHANGED | msg svc:inv:84; reason :339 | :100 | GENUINE | USER | no HTTP test; service-level only: `src/services/invitations.revive.test.ts:138` (reason) |

**C. Sequential retry:** **409 O1**, because the pending row created by the first call is found at svc:inv:262-272. T:stu:1545-1551 pins this with a status-only check.

**Out of scope:** 6 (401 ×2, 403, 429, Invalid JSON, schema 400).

---

## 21. PUT /api/students/[id]

**A. Callers:** all four use `readErrorMessage` and show red text.
- `src/components/booking/booking-flow.tsx:63` (`role=alert`, :254)
- `src/components/student/notifications-form.tsx:87` (:152)
- `src/components/student/name-form.tsx:66` (`role=alert`, :131-133)
- `src/components/student/tier-form.tsx:52` (:116)

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| P1 | 404 | `Student not found` | — | students/[id]/route.ts:98 (`update` where `deletedAt: null` hits P2025 and becomes null) | :98 | GENUINE (concurrent erasure only) | DEV? (the model name, addressed to the student about themselves) | T:stu:1848-1850 (status only) |

**C. Sequential retry:** **200**, idempotent. `tierSelectedAt` is stamped again whenever `incomeTier` is present (:85-93).

**Out of scope:** 6 (401 ×2, Invalid JSON, schema 400, "No valid fields to update" at :79, 403 "Access denied" at :103, which compares against the session).

---

## 22. PATCH /api/students/[id]

**A. Callers:** `src/components/students/archive-student-button.tsx:22`. It uses `readErrorMessage` and shows red text.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| Q1 | 403 | `Student not in your contacts` | — | students/[id]/route.ts:129 (no `TeacherStudent` link) | :129 | GENUINE | USER (note: in today's UI, "Contacts" means pending invitations, not linked students) | T:stu:1222-1224 (status + exact message) |

**C. Sequential retry:** **200** with `action: 'unchanged'` (:133-135).

**Out of scope:** 4 (401 ×2, 403 "Access denied" at :115 for a missing teacher role, 400 state at :122).

---

## 23. PUT /api/students/[id]/privacy

**A. Callers:** `src/components/student/teacher-privacy-card.tsx:85`. It checks status only.
- **Any** 403, including `NOT_YOUR_PROFILE`, shows the client's own red copy: "This teacher is no longer connected to your account, so these settings no longer apply."
- Every other failure, including the 409 erased response, shows the fixed red "Could not save. Try again."
- The server message is never shown.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| R1 | 403 | `Access denied` | TEACHER_NOT_LINKED | privacy/route.ts:110 | :110 | GENUINE (the link was removed) | DEV? (generic auth wording for a state; it gives the user nothing to act on) | `tests/integration/privacy-api.test.ts:203-207` (status + code) |
| R2 | 409 | `This account has been deleted` | — | reason at `src/services/student-privacy.ts:46` | privacy/route.ts:117 | GENUINE (concurrent erasure only) | USER | `src/app/api/students/[id]/privacy/route-lock-order.test.ts:213` (status + exact message) |

**C. Sequential retry:** **200**, idempotent. The upsert writes the same fields again (`student-privacy.ts:28-43`).

**Out of scope:** 6 (401 ×2, 403 "Student access required", 403 `NOT_YOUR_PROFILE` at :101 from a session comparison, Invalid JSON, schema 400).

---

## 24. DELETE /api/teacher-links/[teacherId]

**A. Callers:** `src/components/student/teacher-privacy-card.tsx:135`. It uses `readErrorMessage` and shows a red caption (:255). On success it settles (`unlinked`) so a second DELETE cannot be sent.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| S1 | 409 | `This account has been deleted` | — | reason at svc:inv:1615 | teacher-links/route.ts:48 | GENUINE (concurrent erasure, or a stray link on an erased student) | USER | no HTTP test; service-level only: `invitations-lock-order.test.ts:1966`, `:2002` (reason) |
| S2 | 404 | `Teacher link not found` | — | reason at svc:inv:1470 (no link), :1630 (P2025 race) | :50 | BOTH: ALREADY on the sequential retry after a committed unlink; GENUINE when the student was never linked. "No such teacher" and "not linked" are uniform by design (route docblock :24-27) | DEV? ("Teacher link" is an internal concept) | T:inv:1813 (status only) |

**C. Sequential retry:** **404 S2** (svc:inv:1464-1470).

**Out of scope:** 3 (401 ×2, 403).

---

## 25. PUT /api/teachers/[id]

**A. Callers:** `src/components/settings/profile-form.tsx:106`. It parses `json.error?.message` itself and shows red text (`role=alert`, :233). It **never reads `code`**.

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| T1 | 409 | `Page slug already in use` | SLUG_TAKEN | teachers/[id]/route.ts:53 | :53 | GENUINE | DEV? (it matches this form's own "Page slug" label, :174, but the same code reads "Page address" in signup) | `tests/integration/teachers-api.test.ts:130-135` (status + code) |

A race past the pre-check would throw P2002 at :61, which lands in the generic code-less 409 ("Resource already exists"). That path is not deliberate.

**C. Sequential retry:** **200**, idempotent. `existing.id === id` skips the refusal (:52).

**Out of scope:** 7 (401 ×2, 403 "Teacher access required", 403 "Access denied" at :40 from a session comparison, Invalid JSON, schema 400, "No valid fields to update" at :58).

---

## 26. POST /api/notifications/[id]/read

**A. Callers:** both **ignore the response entirely** (no `res.ok` check) and then refresh.
- `src/components/layout/notification-list.tsx:26` (it has already marked the item read optimistically)
- `src/components/student/updates-strip.tsx:32`

**B.**

| # | status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|---|
| U1 | 404 | `Notification not found` | — | notifications/[id]/read/route.ts:22 | :22 | GENUINE | DEV? (model name; no user ever sees it) | none |
| U2 | 403 | `Access denied` | — | :31 (the stored `recipientId` does not match) | :31 | GENUINE | DEV? (generic) | `tests/integration/notifications-api.test.ts:74` (status only) |

**C. Sequential retry:** **200**, idempotent (`markAsRead` sets `isRead: true`, `src/services/notifications.ts:134-142`).

**Out of scope:** 2 (401 ×2).

---

## Summary

**Pairs in group:** 26.
**Pairs with no client caller:** 0. Every pair has at least one non-test `fetch` in `src/`.

**In-scope rows: 58.** Rows are counted per `respondError` site × pair, so the shared `casMatchedNothing` and `shared.ts` responses are counted once in each pair that can reach them.
- USER: 34
- DEV: 3
- DEV?: 21

DEV rows (3):
- POST /api/auth/magic-link/verify — 400 — `Invalid or expired magic link`
- POST /api/auth/passkey/authenticate/verify — 400 — `Invalid or expired challenge`
- POST /api/invitations/[id]/respond — 404 — `Invitation not found`

DEV? rows (21):
- POST /api/account/onboarding — 409 — `The checklist is not settled yet`
- POST /api/account/student-profile — 409 — `Account already has a student profile` (×3 sites: :50, :140, :160)
- POST /api/account/student-profile — 409 — `Account has no profile to copy from`
- POST /api/account/teacher-profile — 409 — `Account already has a teacher profile` (×2 sites: :39, :83)
- POST /api/auth/magic-link/claim — 400 — `Account not found`
- POST /api/auth/magic-link/verify — 400 — `Account not found`
- POST /api/auth/passkey/authenticate/verify — 400 — `Credential not found`
- POST /api/auth/passkey/authenticate/verify — 400 — `Authentication verification failed`
- POST /api/auth/passkey/register/options — 404 — `Account not found`
- POST /api/auth/passkey/register/options — 404 — `Account has no profile`
- POST /api/auth/passkey/register/verify — 400 — `No pending registration challenge`
- POST /api/auth/passkey/register/verify — 400 — `Registration verification failed`
- PUT /api/students/[id] — 404 — `Student not found`
- PUT /api/students/[id]/privacy — 403 — `Access denied` (TEACHER_NOT_LINKED)
- DELETE /api/teacher-links/[teacherId] — 404 — `Teacher link not found`
- PUT /api/teachers/[id] — 409 — `Page slug already in use`
- POST /api/notifications/[id]/read — 404 — `Notification not found`
- POST /api/notifications/[id]/read — 403 — `Access denied`

**Uniform by design, so their wording is not graded:**
- magic-link/send, student-signup and teacher-signup always answer 200.
- claim E1 is one message for all of its failure causes.
- teacher-links S2 uses one 404 for "no such teacher" and "not linked".
**Which DEV and DEV? rows a user can actually see (24 rows in total):**
- **Never displayed (15):** B1, D1, D3, F1, F2, G1, G2, G3, H1, H2, I1, I2, R1, U1, U2. For each of these, every caller ignores the server message or replaces it with its own copy.
- **Displayed via a caller's red error text (9):**
  - C1, C3 and C5: only through `booking-name-step`. `join-as-student` hides every 409, and `set-up-student-side` treats ALREADY_STUDENT as success.
  - C2: through `set-up-student-side` and `booking-name-step`.
  - E2: through `handoff-code-entry`.
  - N1: through `pending-invitation-card`.
  - P1: through the four student forms.
  - S2: through `teacher-privacy-card`.
  - T1: through `profile-form`.

**Rows with a code: 29. Rows without: 29.**
Codes seen on in-scope rows: PARTIAL_ERASURE_BUSY, PARTIAL_ERASURE, ERASURE_BUSY, ERASURE_FAILED, ONBOARDING_NOT_SETTLED, ALREADY_STUDENT, NO_PROFILE_SOURCE, ACCOUNT_EXISTS, ALREADY_TEACHER, SLUG_TAKEN, DECLINED_IS_PERMANENT, NOT_PENDING, ALREADY_INVITED, ALREADY_LINKED, DECLINED, CONTACT_CHANGED, ALREADY_ANSWERED, TEACHER_NOT_LINKED.

Code-less in-scope rows: E1, E2, F1, F2, G1, G2, G3, H1, H2, I1, I2, J1, J5, J8, K1, K3, K5, L1, M1, M4, N1, N2, P1, Q1, R2, S1, S2, U1, U2.

**ALREADY rows (5):**
- C1: POST student-profile — 409 — `Account already has a student profile` (pre-check)
- C5: POST student-profile — 409 — same message (email-race site)
- D1: POST teacher-profile — 409 — `Account already has a teacher profile` (pre-check)
- K3: DELETE invitations/[id] — 404 — `Contact not found` (post-CAS)
- O1: POST students — 409 — `You have already invited this person — …`

**BOTH rows (10):**
- C3: POST student-profile — 409 ALREADY_STUDENT (accountId site)
- D2: POST teacher-profile — 409 SLUG_TAKEN
- D3: POST teacher-profile — 409 ALREADY_TEACHER (catch site)
- E1: POST claim — 400 `That code did not work…`
- F1: POST verify — 400 `Invalid or expired magic link`
- G1: POST passkey authenticate/verify — 400 `Invalid or expired challenge`
- I1: POST passkey register/verify — 400 `No pending registration challenge`
- K1: DELETE invitations/[id] — 404 `Contact not found` (pre-check)
- N3: POST respond — 409 ALREADY_ANSWERED (decline repeat)
- S2: DELETE teacher-links — 404 `Teacher link not found`

**Sequential retries that are not 2xx, beyond the rows above:** DELETE /api/account gets a 401 (out of scope). The ticket paths of student-profile and teacher-profile get a 401 when the original cookies are replayed. **Duplicate side effects on retry:** magic-link/send, student-signup, teacher-signup and invitations resend each send or attempt delivery again.

**Every distinct wire code in the group, and where it is written:**
- PARTIAL_ERASURE_BUSY — `src/app/api/account/route.ts:78`
- PARTIAL_ERASURE — `src/app/api/account/route.ts:83`
- ERASURE_BUSY — `src/app/api/account/route.ts:96`
- ERASURE_FAILED — `src/app/api/account/route.ts:101`
- ONBOARDING_NOT_SETTLED — `src/app/api/account/onboarding/route.ts:41`
- ALREADY_STUDENT — `src/app/api/account/student-profile/route.ts:50`, `:140`, `:160`
- NO_PROFILE_SOURCE — `src/app/api/account/student-profile/route.ts:63`
- ACCOUNT_EXISTS — `src/app/api/account/student-profile/route.ts:156`
- ALREADY_TEACHER — `src/app/api/account/teacher-profile/route.ts:39`, `:83`
- SLUG_TAKEN — `src/app/api/account/teacher-profile/route.ts:66`; `src/app/api/teachers/[id]/route.ts:53`
- DECLINED_IS_PERMANENT — `src/app/api/invitations/[id]/shared.ts:59`
- NOT_PENDING — `src/app/api/invitations/[id]/shared.ts:71`
- ALREADY_INVITED — `src/app/api/invitations/[id]/route.ts:258`; for POST /api/students the code is `result.reason` (`src/app/api/students/route.ts:100`), from `InviteRefusal` (`src/services/invitations.ts:28`), the `REFUSAL_MESSAGES` key (:80), and the reason literals (:272, :362)
- ALREADY_LINKED — `src/services/invitations.ts:29` (type), `:82` (map), `:309` (reason); relayed at `students/route.ts:100`
- DECLINED — `src/services/invitations.ts:30`, `:83`, `:271`; relayed at `students/route.ts:100`
- CONTACT_CHANGED — `src/services/invitations.ts:31`, `:84`, `:339`; relayed at `students/route.ts:100`
- ALREADY_ANSWERED — `src/app/api/invitations/[id]/respond/route.ts:52`
- TEACHER_NOT_LINKED — `src/app/api/students/[id]/privacy/route.ts:110` (the GET uses it at :64)
- NOT_YOUR_PROFILE (out of scope, session comparison) — `src/app/api/students/[id]/privacy/route.ts:101` (the GET uses it at :54)

Service reason literals that never reach the wire as codes:
- `NOT_FOUND` — svc:inv:1215, :1379
- `NOT_PENDING` — svc:inv:1215, :1379; the wire sends ALREADY_ANSWERED instead
- `STUDENT_ERASED` — svc:inv:1215, :1463; `student-privacy.ts:25`; sent without a code
- `NOT_LINKED` — svc:inv:1463; sent without a code

**Surprises and contradictions.** None of them contradicts the background: `respondError`, `readError`/`readErrorMessage` and `classifyApiError` at `api-errors.ts:433` all match it.

1. **`join-as-student.tsx:26` treats any 409 as success, on status alone.** `set-up-student-side.tsx:21-28` is the sibling caller of the same route, and it explicitly warns against exactly that; it keys on `code === 'ALREADY_STUDENT'`.
2. **POST student-profile can answer ALREADY_STUDENT for an account that has no live student profile.** This is from reading the code, not from a run. `Student.accountId` is `@unique` (`prisma/schema.prisma`, model Student), and student erasure does not clear `accountId` (`gdpr.ts:748-763`). Take a dual account whose student half is erased and whose teacher half is live, for example after a PARTIAL_ERASURE. Its "join as student" create collides on `accountId` and gets C3. `join-as-student` then reads that as success and refreshes, which loops. No test covers this.
3. **teacher-profile's catch (`:81-85`) maps an `Account.email` collision on the ticket path to ALREADY_TEACHER.** The message says "Account already has a teacher profile", and the client shows "You already teach here / There is already a teacher page for {email}". Both are false when the account that appeared is student-only. `student-profile` answers the same case with ACCOUNT_EXISTS. `isUniqueConflictOn`'s docblock (`src/lib/unique-conflict.ts:24-31`) treats the two collisions as one, meaning "email already in use". This path is untested.
4. **SLUG_TAKEN has two messages for one code:** "Page address already in use" in signup and "Page slug already in use" in settings. The comment at `teachers-api.test.ts:131-133` says the settings form needs SLUG_TAKEN to "render its inline error", but `profile-form.tsx` never reads `code`; it shows `error.message` in the form-level alert. On a teacher-profile session double-tap, the losing request can get SLUG_TAKEN for the page the winning request just created (reading only).
5. **DECLINED_IS_PERMANENT's copy ("…but it cannot be removed.") is also served for PUT (edit) and resend.** Neither of those actions removes anything.
6. **NOT_PENDING's copy asserts "they are now on your Students list".** An `accepted` row can outlive its link: `inviteContact`'s comment at svc:inv:277-284 says erasure leaves an accepted Invitation behind after deleting TeacherStudent, and `unlinkTeacher` leaves `delivered:false` rows as they are. So the sentence can be false.
7. **The token `NOT_PENDING` means two different things in this group.** As a service reason, accept and decline relay it as wire code ALREADY_ANSWERED. As a wire code (`shared.ts`), it is the teacher-side "already accepted" refusal.
8. **DELETE /api/invitations/[id]'s comment (R:inv:292-294) calls the vanished-row case "the retry this route is meant to survive".** A sequential retry actually gets a 404 (K1), not a 2xx. The UI never retries because it navigates away on success.
9. **`booking-sign-in.tsx` ignores student-signup's `delivered` flag,** so a failed send still shows "Check your inbox". `booking-name-step.tsx` does read it. `login/page.tsx` and `booking-sign-in.tsx` replace every failure, including a 429 with its retry time, with fixed copy.
10. **`teacher-privacy-card.tsx:91-103` maps every 403 to the "no longer connected" copy,** including NOT_YOUR_PROFILE. It maps the 409 erased response to "Could not save. Try again." Its comment also points at "the CRM-removal route… refuses to remove a student with `claimedAt` set". `remove-student-button.tsx:14-15` says that route (DELETE /api/students/[id]) was deleted.
11. **POST /api/notifications/[id]/read checks existence (404) before ownership (403),** so it distinguishes an unknown notification id from someone else's. Both callers ignore the response completely.
12. **Status choice.** "Account not found" is a stored-state answer sent as a 400 (claim; verify via `MAGIC_LINK_REFUSED_STATUS`). On verify it is also the answer for a `student_signup` token with a bad redirect, which `signup-ticket.ts:176-181` itself says "is not that". The tests for that path (`student-signup-verify.test.ts:93`, `:106`; T:tsu:518) pin status only.
13. **"This account has been deleted" (STUDENT_ERASED) is a code-less 409 in three routes:** respond, privacy PUT and teacher-links DELETE. Only the privacy route has an HTTP-level test; the other two are covered by service-level tests only.
14. **UNKNOWN:** whether passkey verification mismatches return `verified: false` (G3 and I2) or throw into `classifyApiError`'s generic 500. This was not measured.
15. **`create-student-form.tsx:88` calls `res.json()` on an error response without a catch,** so a non-JSON error surfaces as "Network error".
