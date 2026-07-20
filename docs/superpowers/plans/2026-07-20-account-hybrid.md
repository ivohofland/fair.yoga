# Account Hybrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One login per human — an `Account` owns auth (email, sessions, passkeys); `Teacher`/`Student` become optionally-linked profiles; a signed-in teacher can join a class as a student.

**Architecture:** Additive schema change plus SQL backfill; session identity moves from `(userId, userType)` to `accountId` with per-request profile resolution (stateless-by-route authorization). Domain FKs and email columns do not move. Spec: `docs/superpowers/specs/2026-07-20-account-hybrid-design.md`.

**Tech Stack:** Next.js App Router, Prisma/PostgreSQL, Vitest, Playwright.

## Global Constraints

- TypeScript strict; no `any`.
- Every behavior change lands test-first (watch it fail).
- Schema changes only via `npx prisma migrate dev --name <desc>` (never db push).
- Redirect values are always `relativePath`-validated; profile attachment only from an authenticated session.
- Anti-enumeration: signup responses identical regardless of account state.
- Dual-role default landing: `teacherId ? '/' : '/bookings'`.
- Design tokens only; no new dependencies.

---

### Task 1: Schema + migration with backfill

**Files:**
- Modify: `prisma/schema.prisma` (Account model; `accountId` on Teacher/Student; Session/PasskeyCredential columns)
- Create: migration via `npx prisma migrate dev --create-only --name account_hybrid`, then edit its SQL

**Interfaces:**
- Produces: `Account { id, email, createdAt }`; `Teacher.accountId: String @unique` (NOT NULL); `Student.accountId: String? @unique`; `Session { id, accountId, expiresAt, createdAt }`; `PasskeyCredential { id, accountId, publicKey, counter, transports, createdAt }`.

- [ ] Schema edits: add `model Account { id String @id @default(uuid())  email String @unique  createdAt DateTime @default(now())  teacher Teacher?  student Student? }`; on Teacher add `accountId String @unique` + `account Account @relation(fields: [accountId], references: [id])`; on Student add `accountId String? @unique` + optional relation; on Session replace `userId`/`userType` with `accountId String` + `@@index([accountId])`; same for PasskeyCredential.
- [ ] `npx prisma migrate dev --create-only --name account_hybrid`, then edit the generated SQL so the backfill runs between column-add and NOT-NULL/drop steps:

```sql
-- after CREATE TABLE "Account" and ALTER TABLE ... ADD COLUMN "accountId" (nullable everywhere first):
INSERT INTO "Account" (id, email, "createdAt")
  SELECT gen_random_uuid(), t.email, t."createdAt" FROM "Teacher" t;
UPDATE "Teacher" t SET "accountId" = a.id FROM "Account" a WHERE a.email = t.email;
-- claimed students: reuse a teacher's account when emails match (absorbs shadowed duals), else new account
UPDATE "Student" s SET "accountId" = a.id FROM "Account" a
  WHERE s."claimedAt" IS NOT NULL AND a.email = s.email;
INSERT INTO "Account" (id, email, "createdAt")
  SELECT gen_random_uuid(), s.email, s."createdAt" FROM "Student" s
  WHERE s."claimedAt" IS NOT NULL AND s."accountId" IS NULL;
UPDATE "Student" s SET "accountId" = a.id FROM "Account" a
  WHERE s."claimedAt" IS NOT NULL AND s."accountId" IS NULL AND a.email = s.email;
-- sessions / passkeys: resolve accountId through the profile the row pointed at
UPDATE "Session" se SET "accountId" = t."accountId" FROM "Teacher" t
  WHERE se."userType" = 'teacher' AND se."userId" = t.id;
UPDATE "Session" se SET "accountId" = s."accountId" FROM "Student" s
  WHERE se."userType" = 'student' AND se."userId" = s.id;
DELETE FROM "Session" WHERE "accountId" IS NULL;   -- sessions of unclaimed/gone users
-- same three statements for "PasskeyCredential"
-- then: ALTER TABLE "Teacher" ALTER COLUMN "accountId" SET NOT NULL;
--       ALTER TABLE "Session" ALTER COLUMN "accountId" SET NOT NULL; (and PasskeyCredential)
--       drop "userId"/"userType" columns + old indexes
```

- [ ] Apply on dev DB; `npx prisma migrate dev` also regenerates the client. Then run the same against the test DB (vitest project does this via env; run `DATABASE_URL=$DATABASE_URL_TEST npx prisma migrate deploy`).
- [ ] Verify backfill invariants with one-off psql: every Teacher has accountId; every claimed Student has accountId; Session/PasskeyCredential have no NULL accountId.
- [ ] Commit (schema + migration only — the app is red until Task 2; commit message says so).

### Task 2: Session core — new `SessionUser`, session lib, request helpers

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/auth/session.ts`, `src/lib/session.ts`, `src/lib/api-utils.ts`
- Test: `src/lib/auth/session.test.ts` (rewrite), `src/lib/api-utils.test.ts` (adjust)

**Interfaces:**
- Produces: `SessionUser { sessionId: string; accountId: string; teacherId: string | null; studentId: string | null }`; `createSession(db, accountId: string): Promise<string>`; `validateSession(db, token): Promise<SessionUser | null>`; `getSession(): Promise<SessionUser | null>`; `requireTeacherSession()` redirects unless `teacherId`; api-utils teacher/student guards check profile presence.

- [ ] Rewrite `session.test.ts` expectations first: create an Account (+Teacher and/or Student profiles) fixture; `createSession(prisma, accountId)`; `validateSession` returns both profile ids for a dual account, `null` profile for missing ones; session of a deleted account is invalidated; add: account with zero profiles → invalid. Run → fails (old signatures).
- [ ] Implement:

```ts
// validateSession core replaces the userExists check with:
const account = await db.account.findUnique({
  where: { id: session.accountId },
  select: { id: true, teacher: { select: { id: true } }, student: { select: { id: true } } },
});
if (!account || (!account.teacher && !account.student)) { /* delete session, return null */ }
return {
  sessionId: session.id,
  accountId: account.id,
  teacherId: account.teacher?.id ?? null,
  studentId: account.student?.id ?? null,
};
```

- [ ] `src/lib/session.ts`: `requireTeacherSession()` → `if (!session?.teacherId) redirect('/login'); return session;`
- [ ] `src/lib/api-utils.ts`: teacher guard checks `result.teacherId`, student guard `result.studentId`; both return the full `SessionUser`.
- [ ] Run session + api-utils unit tests green. Commit. (`tsc` still red across the app — expected until Task 3.)

### Task 3: Compiler-driven call-site sweep

**Files (let `npx tsc --noEmit` enumerate; expected set):**
- `src/app/(teacher)/layout.tsx` → guard `!session?.teacherId`
- `src/app/(student)/layout.tsx` → guard `!session?.studentId`; when `teacherId` present but no student profile, still redirect `/login`? No — that state reaches student pages only for teacher-only accounts: redirect to `/` instead (their home).
- `src/app/(public)/[slug]/book/[classId]/page.tsx` → `session?.studentId` for the student lookup (Task 7 extends this page further)
- `src/app/(student)/account/page.tsx`, `src/app/(student)/bookings/page.tsx` → `session.studentId`
- `src/app/api/auth/session/route.ts` → return new shape
- `src/app/api/notifications/stream/route.ts` → SSE recipient: subscribe for whichever profiles exist (teacher and/or student ids)
- All API routes using api-utils guards: replace `result.userId` with `result.teacherId!`/`result.studentId!` per route's domain
- `src/app/api/auth/magic-link/verify/route.ts` + passkey verify: temporary shim (fully rewritten in Tasks 4–5)

**Rule:** teacher context ⇒ `teacherId`, student context ⇒ `studentId`; never reintroduce `userType`.

- [ ] Sweep until `npx tsc --noEmit` is clean; run full unit suite; run booking + a11y e2e as smoke. Commit.

### Task 4: Magic-link verify — account resolution + claim-at-verify

**Files:**
- Create: `src/lib/auth/account.ts` + `src/lib/auth/account.test.ts`
- Modify: `src/app/api/auth/magic-link/verify/route.ts`, `src/lib/auth/index.ts` (export)

**Interfaces:**
- Produces: `resolveOrClaimAccount(db, email): Promise<{ accountId: string; teacherId: string | null; studentId: string | null } | null>` — finds the account; else claims an unclaimed Student (creates Account, links, sets `claimedAt`); else null.

- [ ] Unit tests first (`account.test.ts`, real test DB like session tests): existing account returned; unclaimed student with email → account created + linked + `claimedAt` set; unknown email → null; already-claimed student resolves via its account.
- [ ] Implement; rewrite the verify route:

```ts
const resolved = await resolveOrClaimAccount(prisma, email);
if (!resolved) return respondError('Account not found', 400);
const sessionToken = await createSession(prisma, resolved.accountId);
const fallback = resolved.teacherId ? '/' : '/bookings';
const redirectTo = tokenRedirect && isSafeRelativePath(tokenRedirect) ? tokenRedirect : fallback;
```

- [ ] Integration: `tests/integration/auth.test.ts` — adjust to account world; add dual-account fixture asserting fallback `/`. Run green. Commit.

### Task 5: Passkey routes on accounts

**Files:**
- Modify: `src/app/api/auth/passkey/register/options/route.ts`, `register/verify/route.ts`, `authenticate/options/route.ts`, `authenticate/verify/route.ts`, `src/lib/auth/passkey.ts` (drop `userType` param)
- Test: `tests/e2e/passkey.spec.ts` (seed update + shared-credential assertion), `src/lib/auth/passkey.test.ts`

- [ ] Register options: user = account (userName = account email; display name from whichever profile exists); existing credentials by `accountId`. Register verify stores `accountId`.
- [ ] Authenticate verify: credential → account → `createSession(prisma, credential.accountId)`; fallback = account has teacher profile ? `'/'` : `'/bookings'`; `redirect` passthrough unchanged.
- [ ] E2e: seeds create Account rows; extend the existing journey — after the /login leg, add the teacher profile to the same account via SQL and assert the SAME passkey now signs into `/` (dual default landing). Run green. Commit.

### Task 6: Signup routes

**Files:**
- Modify: `src/app/api/teachers/route.ts`, `src/app/api/auth/student-signup/route.ts`
- Test: `tests/integration/passkey-api.test.ts` stays; extend `tests/integration/auth.test.ts` or add route tests in `tests/integration/signup-api.test.ts`

- [ ] Tests first: teacher signup with email owning any account → 409 EMAIL_TAKEN; fresh → Account + linked Teacher created. Student signup: fresh email → Account + claimed Student; teacher-only account email → no student row created, still 200; unclaimed-student email → no account created yet, still 200.
- [ ] Implement per spec (teacher create wraps Account+Teacher in a transaction). Run green. Commit.

### Task 7: Join flow — teacher books a class

**Files:**
- Create: `src/app/api/account/student-profile/route.ts`, `src/components/booking/join-as-student.tsx`
- Modify: `src/app/(public)/[slug]/book/[classId]/page.tsx`
- Test: `tests/e2e/account-hybrid.spec.ts` (new, headline journey), integration test for the endpoint

- [ ] Endpoint tests first: 401 signed out; 409 when student profile exists; creates Student {name from teacher profile, email = account email, incomeTier 3, claimedAt now, accountId} when teacher-only.
- [ ] `POST /api/account/student-profile` implementation, then the panel:

```tsx
// join-as-student.tsx ('use client'): teal-tint card — "You're signed in as
// {firstName}." + body "Set up your student side to join this class — your
// income tier picks your price, and you can change it any time." +
// primary Button "Join as a student" → POST, then router.refresh().
```

- [ ] Booking page: `session.studentId` → BookingFlow (as today); `session.teacherId && !session.studentId` → `<JoinAsStudent firstName={teacher.firstName} />`; signed out → BookingSignIn.
- [ ] E2e journey (new spec file): seed teacher A with open class, teacher B with account+session cookie; B opens A's booking page → sees join panel (not the sign-in form) → joins → BookingFlow appears → books tier 2 → "You're in"; assert Student row linked to B's account and registration exists. Watch it fail before the implementation lands, then green. Commit.

### Task 8: Cross-links + GDPR account cleanup

**Files:**
- Modify: `src/app/(teacher)/settings/page.tsx` (link "Your bookings as a student" when `session.studentId`), `src/app/(student)/account/page.tsx` ("Your teaching side" when `session.teacherId`), `src/services/gdpr.ts` (+ its test)

- [ ] GDPR tests first: erasing a student profile on a dual account keeps the account (teacher remains) but unlinks/deletes the student; erasing the last profile deletes the account and its sessions/credentials (cascade or explicit deletes by accountId).
- [ ] Implement; add the two links (chevron-row style per design system). Run gdpr unit + affected e2e. Commit.

### Task 9: Test-suite sweep + full verification

**Files:** every e2e spec seeding sessions (`auth`, `booking`, `recurring`, `visual`, `a11y`, `account`, `teacher-journey`, `student-journey`, `passkey`), integration tests, `prisma/seed.ts` if present.

- [ ] Mechanical seed rule: create Account (email = profile email) → profile rows get `accountId` → session rows become `{ id: hashToken(token), accountId, expiresAt }`. Add a tiny shared helper if three or more specs repeat it.
- [ ] Full gate: `npx tsc --noEmit` · `npm run lint` · `npm test` · `npx playwright test` (all green, visual suite unchanged pixels expected — no UI moved except the booking page teacher state and two settings links; regen only what legitimately changed and eyeball it).
- [ ] Commit; push branch `feat/account-hybrid`; open PR; watch CI.

## Self-Review

- Spec coverage: model→T1, session→T2/3, magic-link+claim→T4, passkey→T5, signups→T6, join flow→T7, cross-links+GDPR→T8, testing→throughout+T9. Login-landing decision lands in T4/T5 fallbacks. Gaps: none found.
- Placeholders: none — sweeps are compiler-enumerated with explicit mapping rules.
- Type consistency: `SessionUser` shape identical across T2 producers and T3–T8 consumers; `resolveOrClaimAccount` return matches T4 route usage.
