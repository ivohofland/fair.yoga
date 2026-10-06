# Credentials outlive the session — plan (#765)

Built as: `add-passkey.tsx` was deleted and its behaviour folded into `AccountSecurity`; see the spec's "As built".

Spec: `docs/superpowers/specs/2026-10-06-credentials-outlive-session-design.md`. Tool-agnostic: files, behaviour, tests.
Each task is test-first (failing test seen, then implementation), and each guard gets a break-it step recorded in the task report.

## Task 1 — Session lifetime and stream revalidation (items 2, 3)
Files: `src/lib/auth/session.ts` (+ `session.test.ts`), `src/app/api/notifications/stream/route.ts` (+ its test, creating one if absent).
- Absolute 90-day ceiling from `createdAt`; extend only when `expiresAt - now < 15 days`, to `min(now+30d, createdAt+90d)`; `setSessionCookie` Max-Age becomes the 90-day ceiling.
- Stream: each 30 s keepalive tick revalidates the connect-time token; null closes the stream; a thrown error keeps it and logs.
- Mutation-prove: revert the `expiresAt` condition to `createdAt`; remove the ceiling check; remove the tick revalidation.

## Task 2 — Passkey backend (item 1, API)
Files: `src/lib/api-error-codes.ts` (`RECENT_AUTH_REQUIRED: 403`), `src/lib/auth/` (a `requireRecentAuth`-style check on `Session.createdAt`, 5 min), `register/options` + `register/verify` routes, new `GET /api/auth/passkey`, `DELETE /api/auth/passkey/[id]`, `DELETE /api/auth/session/all`, a `FireAndForget` `deliverPasskeyAddedNotice` + template in `email-templates.ts`/`email.ts`, docs (`docs/technical-architecture.md` auth section: recent-auth rule, the item-4 decision, grep command for FireAndForget unchanged).
- Behaviour per spec §1. Integration tests assert the code, not the message; other-account delete leaves the row and answers the same 404 as a missing id.
- Mutation-prove each guard (recent-auth on both routes, the `accountId` in the delete filter, the account scoping of revoke-all).

## Task 3 — Account security UI (item 1, UI)
Files: `src/components/account/` (new `account-security.tsx` + test; `add-passkey.tsx` gains the step-up state or is folded in), the two pages that render `AddPasskey` (`settings/profile`, student `account`), e2e where `tests/e2e/passkey.spec.ts` can be extended cheaply.
- List with Remove, Add (step-up on `RECENT_AUTH_REQUIRED` via the magic-link send with `redirect` to the current path), Sign out everywhere (then `clearOfflinePages()` and navigate to `/login`).
- Design rules from CLAUDE.md: mobile-first rows ≥56px, text not icons, no motion, no shadows.
- Check the CLAUDE.md census-guard hazard (`new-route-trips-census-guards`): no new page is added, so none expected; confirm with `pnpm run verify`.
