# Student Settings Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/account` becomes a chevron-row settings index with four sub-pages, including the missing per-teacher privacy controls (issue #21).

**Architecture:** Index page mirrors `src/app/(teacher)/settings/page.tsx`. `StudentSettingsForm` splits into `TierForm` and `NotificationsForm`. The privacy sub-page is a server component (Prisma reads) rendering a `TeacherPrivacyCard` client component per connected teacher, writing through the existing privacy route — which gets two one-line fixes (`shareFullName` omitted from both the GET virtual default and the upsert create branch).

**Tech Stack:** Next.js App Router server/client components, existing APIs only, Vitest integration (live :3000), Playwright e2e (runs in CI).

**Spec:** `docs/superpowers/specs/2026-07-21-student-settings-index-design.md`

## Global Constraints

- Row pattern verbatim from teacher settings: `flex items-center gap-3 min-h-14 py-2 border-b border-border last:border-b-0 no-underline` + chevron icon.
- Nothing dropped from today's `/account`: teaching-side cross-link and Sign-in section stay on the index; DataAndDeletion moves unmodified to `/account/data`.
- Defaults surfaced in the privacy UI: all shares off, announcements on.
- TypeScript strict; full vitest + `tsc` + `eslint` green; `account.spec.ts` updated (CI runs Playwright).
- Branch: `feat/student-settings-index` (created; spec committed).

---

### Task 1: Privacy API — `shareFullName` in both gaps (TDD)

**Files:**
- Create: `tests/integration/privacy-api.test.ts`
- Modify: `src/app/api/students/[id]/privacy/route.ts` (GET virtual default ~line 41; PUT upsert create ~line 78)

**Interfaces:**
- Produces: GET virtual default includes `shareFullName: false`; PUT persists `shareFullName` on first write. Task 2's privacy page relies on the API round-tripping all six fields.

- [ ] **Step 1: Write the failing tests** — new file, fixtures per house pattern (student + account + hashed-token session, one teacher for scoping, second student for 403):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();
const rawSessionToken = crypto.randomBytes(32).toString('hex');
const BASE_URL = 'http://localhost:3000';
const sessionCookie = `fair_yoga_session=${rawSessionToken}`;

let studentId: string;
let otherStudentId: string;
let teacherId: string;

describe('students privacy API', () => {
  beforeAll(async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Privacy',
        lastName: 'Student',
        email: `privacy-student-${uniqueSuffix}@test.local`,
        account: { create: { email: `privacy-student-${uniqueSuffix}@test.local` } },
        claimedAt: new Date(),
      },
    });
    studentId = student.id;
    const other = await prisma.student.create({
      data: {
        firstName: 'Other',
        lastName: 'Student',
        email: `privacy-other-${uniqueSuffix}@test.local`,
      },
    });
    otherStudentId = other.id;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Privacy',
        lastName: 'Teacher',
        email: `privacy-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `privacy-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Privacy fixture',
        pageSlug: `privacy-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    await prisma.session.create({
      data: {
        id: hashToken(rawSessionToken),
        accountId: student.accountId!,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { id: hashToken(rawSessionToken) } });
    await prisma.studentPrivacy.deleteMany({ where: { studentId } });
    if (studentId) await prisma.student.delete({ where: { id: studentId } });
    if (otherStudentId) await prisma.student.delete({ where: { id: otherStudentId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${uniqueSuffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  it('virtual default carries all six fields, maximum privacy', async () => {
    const res = await fetch(
      `${BASE_URL}/api/students/${studentId}/privacy?teacherId=${teacherId}`,
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.shareFullName).toBe(false);
    expect(data.shareEmail).toBe(false);
    expect(data.sharePhone).toBe(false);
    expect(data.shareBirthday).toBe(false);
    expect(data.shareAddress).toBe(false);
    expect(data.receiveComms).toBe(true);
  });

  it('first PUT persists all six fields — including shareFullName', async () => {
    const res = await fetch(`${BASE_URL}/api/students/${studentId}/privacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        teacherId,
        shareFullName: true,
        shareEmail: true,
        sharePhone: false,
        shareBirthday: false,
        shareAddress: false,
        receiveComms: false,
      }),
    });
    expect(res.status).toBe(200);
    const row = await prisma.studentPrivacy.findUniqueOrThrow({
      where: { studentId_teacherId: { studentId, teacherId } },
    });
    expect(row.shareFullName).toBe(true);
    expect(row.shareEmail).toBe(true);
    expect(row.receiveComms).toBe(false);
  });

  it("rejects touching another student's privacy", async () => {
    const res = await fetch(`${BASE_URL}/api/students/${otherStudentId}/privacy?teacherId=${teacherId}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run — expect the first two to FAIL** (`shareFullName` undefined in default; `false` after first PUT): `npx vitest run --project integration tests/integration/privacy-api.test.ts`

- [ ] **Step 3: Fix the route** — GET virtual default gains `shareFullName: false,` (first field); PUT upsert `create` gains `shareFullName: privacyFields.shareFullName ?? false,`.

- [ ] **Step 4: Re-run — all pass.**

- [ ] **Step 5: Commit** — `fix: privacy API stops dropping shareFullName on first contact`

---

### Task 2: Index + sub-pages + split forms

**Files:**
- Rewrite: `src/app/(student)/account/page.tsx` (index rows; keeps cross-link + Sign-in section)
- Create: `src/app/(student)/account/tier/page.tsx`, `.../notifications/page.tsx`, `.../data/page.tsx`, `.../privacy/page.tsx`
- Create: `src/components/student/tier-form.tsx`, `src/components/student/notifications-form.tsx`, `src/components/student/teacher-privacy-card.tsx`
- Delete: `src/components/student/student-settings-form.tsx`

**Interfaces:**
- Consumes: `PUT /api/students/[id]` (tier / notifications), `PUT /api/students/[id]/privacy` (Task 1), `DataAndDeletion`, `AddPasskey`, `SignOutButton`, `Icon`, `TIER_INFO`, `TIER_QUOTE`.
- Produces: routes `/account` (index), `/account/tier`, `/account/notifications`, `/account/privacy`, `/account/data`. Task 3's e2e edits point at `/account/data`.

Key shapes (each sub-page: back link `← Settings` to `/account`, `type-display` h1, `force-dynamic`, session guard as today):

- Index rows array: `[{ href: '/account/tier', label: 'Your tier' }, { href: '/account/notifications', label: 'Notifications' }, { href: '/account/privacy', label: 'Privacy' }, { href: '/account/data', label: 'Data & deletion' }]` — teacher-settings row markup verbatim.
- `TierForm` = the tier section of the old combined form (radiogroup cards + quote + Save posting `{ incomeTier }`); `NotificationsForm` = the notifications section (email checkbox + essential caption + reminder select + Save posting `{ emailNotifications, reminderPref }`). Same styling classes, same save/error affordances.
- Privacy page (server): `prisma.teacherStudent.findMany({ where: { studentId, isArchived: false }, select: { teacher: { select: { id, firstName, lastName } } } })` + `prisma.studentPrivacy.findMany({ where: { studentId } })`; map to `TeacherPrivacyCard` props `{ studentId, teacherId, teacherName, initial: { six fields } }` with virtual defaults when no row. Empty state: "No teachers yet — book a class first."
- `TeacherPrivacyCard` (client): `bg-sand-soft rounded-card p-5` card, teacher name as `type-label`, six checkboxes (labels: "Full last name", "Email address", "Phone number", "Birthday", "Address", and separated below: "Receive announcements from this teacher"), per-card Save → PUT privacy with `teacherId` + all six, `Saved` caption on success. Page-level caption above the cards: "Teachers only ever see what you share here. New teachers start with everything off. Turning announcements off mutes that teacher completely — in-app and email; the email switch under Notifications is global."

- [ ] Steps: build components → build pages → delete old form → `npx tsc --noEmit` → commit `feat: student settings becomes an index — tier, notifications, privacy, data`.

---

### Task 3: E2e + drive verification + PR

**Files:**
- Modify: `tests/e2e/account.spec.ts:67,85` — `page.goto('/account')` → `page.goto('/account/data')` in both GDPR tests.

- [ ] Update the two gotos; run `npx playwright test account.spec.ts` locally — both GDPR tests pass.
- [ ] Drive (scratchpad script, session as `anna@example.com`): index shows the four rows + Sign-in; `/account/tier` saves a tier change; `/account/privacy` lists Ivo and Sarah (Anna is linked to both in seed), toggling "Full last name" for Sarah persists (DB row check); screenshots inspected.
- [ ] Full gates: `npx vitest run`, `npx tsc --noEmit`, `npm run lint` — green (restart :3000 if 429s).
- [ ] Commit remaining, push, `gh pr create` (Closes #21), verify CI green.
