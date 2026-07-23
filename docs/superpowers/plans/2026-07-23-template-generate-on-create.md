# Template Generate On Create Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recurring-class instances exist the moment the template does — generation wired into template create and re-activate, orphan generate endpoint deleted.

**Architecture:** `generateClassInstances(prisma, undefined, teacherId)` (already idempotent, teacher-scoped, rolling 4-week window) is called synchronously inside `POST /api/class-templates` and inside the pause→active branch of `PATCH /api/class-templates/[id]`. Generation failure is logged, never returned — the cron remains the guarantee. `src/app/api/class-templates/generate/route.ts` is deleted.

**Tech Stack:** Next.js route handlers, Prisma, vitest integration tests (HTTP against `localhost:3000`), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-23-template-generate-on-create-design.md`

## Global Constraints

- TypeScript strict; no `any`, no non-null assertions where narrowing works.
- Test-first: write the failing test, watch it fail, then implement.
- Integration tests need the dev server on `:3000` and Postgres up: `docker compose start db`, then `nohup npm run dev > /tmp/dev.log 2>&1 &` if nothing is listening.
- Response shapes of POST/PATCH must NOT change (spec decision — front-end needs zero changes).
- Commits: repo style is lowercase `feat:`/`fix:`/`test:`/`docs:` with footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: POST /api/class-templates generates instances (TDD)

**Files:**
- Create: `tests/integration/class-templates-api.test.ts`
- Modify: `src/app/api/class-templates/route.ts` (POST handler, after the `prisma.classTemplate.create`)

**Interfaces:**
- Consumes: `generateClassInstances(db, from?, teacherId?)` from `src/services/class-generator.ts` (idempotent; returns count — ignored here); `log` from `src/lib/log.ts`.
- Produces: the test file's fixtures (`teacherId`, `teacherRoomId`, `sessionCookie`, `BASE_URL`, `createdTemplateIds`) that Task 2 extends.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/class-templates-api.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();
const rawSessionToken = crypto.randomBytes(32).toString('hex');
const teacherEmail = `tmpl-teacher-${uniqueSuffix}@test.local`;

let teacherId: string;
let roomId: string;
let teacherRoomId: string;
const createdTemplateIds: string[] = [];

const BASE_URL = 'http://localhost:3000';
const sessionCookie = `fair_yoga_session=${rawSessionToken}`;

/** Wednesday. Any fixed weekday works — assertions derive from this. */
const DAY_OF_WEEK = 3;

function templateBody(classType: string) {
  return {
    teacherRoomId,
    classType,
    dayOfWeek: DAY_OF_WEEK,
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 15,
    minRate: 10,
    targetRate: 20,
    minStudents: 2,
    maxStudents: 8,
  };
}

beforeAll(async () => {
  await prisma.$connect();
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Template',
      lastName: 'Teacher',
      email: teacherEmail,
      account: { create: { email: teacherEmail } },
      bio: 'Teacher for template API tests',
      pageSlug: `tmpl-teacher-${uniqueSuffix}`,
      defaultTimezone: 'UTC',
    },
  });
  teacherId = teacher.id;

  const room = await prisma.room.create({
    data: {
      venueName: 'Template Venue',
      address: `${uniqueSuffix} Template St`,
      city: 'Testville',
      postcode: '1234TP',
      floor: '1',
      roomName: 'Loft',
      maxCapacity: 10,
      createdById: teacherId,
    },
  });
  roomId = room.id;
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
  });
  teacherRoomId = teacherRoom.id;

  const account = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { accountId: true },
  });
  await prisma.session.create({
    data: {
      id: hashToken(rawSessionToken),
      accountId: account.accountId,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
});

afterAll(async () => {
  await prisma.class.deleteMany({ where: { templateId: { in: createdTemplateIds } } });
  await prisma.classTemplate.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.session.deleteMany({ where: { id: hashToken(rawSessionToken) } });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { email: teacherEmail } });
  await prisma.$disconnect();
});

describe('POST /api/class-templates', () => {
  it('creates the template and its four-week instance window in one request', async () => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify(templateBody('Instant Flow')),
    });
    expect(res.status).toBe(201);
    const { data: template } = (await res.json()) as { data: { id: string } };
    createdTemplateIds.push(template.id);

    // The whole point: no cron ran, yet the schedule is populated.
    const instances = await prisma.class.findMany({
      where: { templateId: template.id },
      orderBy: { date: 'asc' },
    });
    expect(instances.length).toBe(4);
    for (const instance of instances) {
      expect(instance.status).toBe('open');
      expect(instance.startTime).toBe('09:30');
      expect(instance.date.getUTCDay()).toBe(DAY_OF_WEEK);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/class-templates-api.test.ts`
Expected: FAIL — `expected 0 to be 4` (template created, no instances).

- [ ] **Step 3: Wire generation into the POST handler**

In `src/app/api/class-templates/route.ts`, add imports:

```ts
import { generateClassInstances } from '@/services/class-generator';
import { log } from '@/lib/log';
```

In the POST handler, between `const template = await prisma.classTemplate.create({...})` and `return respondOk(template, 201)`:

```ts
  // The schedule must show the class the moment the template exists —
  // the cron only tops the rolling window up later. Failure is logged,
  // not returned: generation is guaranteed eventually by the cron, and
  // a 500 here would invite retrying a create that already succeeded.
  try {
    await generateClassInstances(prisma, undefined, session.teacherId);
  } catch (err) {
    log.error({ err, templateId: template.id }, 'instance generation after template create failed');
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integration/class-templates-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/class-templates-api.test.ts src/app/api/class-templates/route.ts
git commit -m "fix: a new recurring template fills its window immediately

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: PATCH pause→active regenerates; archive paths do not (TDD)

**Files:**
- Modify: `tests/integration/class-templates-api.test.ts` (append a describe block)
- Modify: `src/app/api/class-templates/[id]/route.ts` (PATCH handler, default toggle branch only)

**Interfaces:**
- Consumes: Task 1's fixtures (`templateBody`, `sessionCookie`, `BASE_URL`, `createdTemplateIds`) and the wired POST behavior (create → 4 instances).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/class-templates-api.test.ts`:

```ts
describe('PATCH /api/class-templates/[id]', () => {
  it('re-activation tops the window back up; archive and pause do not generate', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify(templateBody('Toggle Flow')),
    });
    expect(create.status).toBe(201);
    const { data: template } = (await create.json()) as { data: { id: string } };
    createdTemplateIds.push(template.id);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);

    // Simulate window drift: one instance vanishes (e.g. teacher-cancelled
    // long ago and pruned). Regeneration is what heals it.
    const first = await prisma.class.findFirstOrThrow({
      where: { templateId: template.id },
      orderBy: { date: 'asc' },
    });
    await prisma.class.delete({ where: { id: first.id } });

    const toggle = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
        method: 'PATCH',
        headers: { Cookie: sessionCookie },
      });

    // active → paused: no generation.
    const pause = await toggle();
    expect(pause.status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);

    // paused → active: the missing instance comes back.
    const activate = await toggle();
    expect(activate.status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);

    // Archive (forces inactive) after removing another instance: no generation,
    // and un-archive leaves the template paused — still no generation.
    const next = await prisma.class.findFirstOrThrow({
      where: { templateId: template.id },
      orderBy: { date: 'asc' },
    });
    await prisma.class.delete({ where: { id: next.id } });
    const archive = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?action=archive`, {
        method: 'PATCH',
        headers: { Cookie: sessionCookie },
      });
    expect((await archive()).status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);
    expect((await archive()).status).toBe(200); // un-archive
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);

    // Explicit activation after un-archive is the "goes live" moment.
    expect((await toggle()).status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/class-templates-api.test.ts`
Expected: FAIL — `expected 3 to be 4` at the paused→active assertion (toggle never generates today).

- [ ] **Step 3: Wire generation into the PATCH toggle branch**

In `src/app/api/class-templates/[id]/route.ts`, add imports:

```ts
import { generateClassInstances } from '@/services/class-generator';
import { log } from '@/lib/log';
```

Replace the default-toggle tail of the PATCH handler:

```ts
  // Default: toggle active/paused
  const updated = await prisma.classTemplate.update({
    where: { id },
    data: { isActive: !template.isActive },
  });

  if (updated.isActive) {
    // Re-activation is a "goes live" moment: top the window up now
    // rather than waiting for the cron — same contract as create.
    try {
      await generateClassInstances(prisma, undefined, session.teacherId);
    } catch (err) {
      log.error({ err, templateId: id }, 'instance generation after template activation failed');
    }
  }

  return respondOk(updated);
```

The `action === 'archive'` branch stays untouched.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integration/class-templates-api.test.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/class-templates-api.test.ts "src/app/api/class-templates/[id]/route.ts"
git commit -m "fix: re-activating a paused template tops its window up immediately

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Delete the orphan generate endpoint

**Files:**
- Delete: `src/app/api/class-templates/generate/route.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — the route provably has no callers.

- [ ] **Step 1: Prove there are no references**

Run: `grep -rn "class-templates/generate" src tests docs --include="*.ts" --include="*.tsx" --include="*.md" | grep -v superpowers`
Expected: only the route file itself (and possibly this plan/spec under docs/superpowers, excluded by the grep).

- [ ] **Step 2: Delete the route**

```bash
git rm src/app/api/class-templates/generate/route.ts
rmdir src/app/api/class-templates/generate 2>/dev/null || true
```

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git commit -m "fix: delete the never-called manual generate endpoint

Generation now lives in the template lifecycle routes; the cron owns
the rolling window. An authenticated endpoint nobody calls is surface,
not safety.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: E2e — the schedule is populated straight from the wizard

**Files:**
- Modify: `tests/e2e/recurring.spec.ts` (the "creates a template through settings" test, and the title/comment of the cron test after it)

**Interfaces:**
- Consumes: the wired POST behavior from Task 1.
- Produces: nothing.

- [ ] **Step 1: Extend the create test (write it failing-first)**

In `tests/e2e/recurring.spec.ts`, at the end of `test('creates a template through settings', ...)` — after `expect(template.isActive).toBe(true);` — add:

```ts
    // No cron has fired: creation itself filled the four-week window,
    // and the schedule shows it immediately.
    expect(await prisma.class.count({ where: { templateId } })).toBe(4);
    await page.goto('/');
    await expect(page.getByText('Recurring Flow').first()).toBeVisible();
```

- [ ] **Step 2: Run the file to verify the new assertion fails on unpatched behavior — or passes if Tasks 1–2 are already merged in this branch**

Run: `npx playwright test tests/e2e/recurring.spec.ts --project=chromium --retries=0`
Expected on this branch (Tasks 1–2 done): PASS. If run against main for verification: FAIL with `expected 0 to be 4`.

- [ ] **Step 3: Retitle the cron test honestly**

The next test's name claims the cron "fills the four-week window" — creation now does that. Change:

```ts
  test('the generation cron fills the four-week window, idempotently', async () => {
```

to:

```ts
  // Creation already filled the window; the cron's job is topping up
  // later weeks and never duplicating what exists.
  test('the generation cron is idempotent over the already-filled window', async () => {
```

Assertions inside stay exactly as they are (they now pin cron idempotency over create-generated rows).

- [ ] **Step 4: Run the full recurring spec on both projects**

Run: `npx playwright test tests/e2e/recurring.spec.ts --retries=0`
Expected: all pass, both projects.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/recurring.spec.ts
git commit -m "test: the wizard's save populates the schedule before any cron

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Full gates, push, PR

**Files:** none new.

- [ ] **Step 1: Full test gates**

Run, each exit-gated:
```bash
npm test
npx playwright test
npx tsc --noEmit && npx eslint
```
Expected: vitest all green (count grows by the new integration tests), Playwright all green, tsc/eslint clean.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/template-generate-on-create
gh pr create --title "fix: recurring instances exist the moment the template does" --body "Closes #44.

## Summary
Spec: \`docs/superpowers/specs/2026-07-23-template-generate-on-create-design.md\`.

- \`POST /api/class-templates\` and the pause→active branch of \`PATCH\` now call the (idempotent, teacher-scoped) \`generateClassInstances\` synchronously — a teacher who saves a weekly class sees it on the schedule immediately, no cron wait. Archive/un-archive/pause/PUT deliberately do not generate; response shapes unchanged.
- Generation failure logs and still returns success: the cron remains the guarantee, and a 500 would invite retrying a create that already succeeded.
- The never-called \`POST /api/class-templates/generate\` endpoint is deleted.

## Test plan
- New HTTP-level integration tests (first for this resource — chips at #53): create → four instances immediately; pause/archive/un-archive generate nothing; re-activation heals a pruned window.
- \`recurring.spec.ts\`: the create test asserts the window and the schedule before any cron fires; the cron test is retitled to what it now pins (idempotent top-up).
- Full vitest + Playwright + tsc + eslint, exit-gated.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Report the PR URL**

---

## Revision (2026-07-23, post-review)

Reality diverged from this plan in three places; the shipped code is right,
the plan text above is not:

- **Task 1's test code is wrong about weekdays.** The schema convention is
  0=Monday (`docs/data-model.md`), so `DAY_OF_WEEK = 3` is Thursday, not
  Wednesday, and `getUTCDay()` (0=Sunday) returns 4 for it — the plan's
  assertion would fail against a correct implementation. The shipped test
  derives `EXPECTED_JS_DAY = (DAY_OF_WEEK + 1) % 7`, the same conversion
  `class-generator.ts` uses.
- **Task 3's grep also matches** the untracked historical audit
  `docs/audits/2026-07-17-security-setup.md` in a working tree; that hit is
  expected and fine (the deletion resolves that audit's open item 11).
- **The review round added hardening beyond this plan:** the PATCH toggle
  refuses archived templates (409), the generator's sweep filters
  `isArchived: false` as defense in depth (with a service test), the
  failure logs carry `teacherId`, and the integration `afterAll` cleans by
  `teacherId` rather than tracked ids.
