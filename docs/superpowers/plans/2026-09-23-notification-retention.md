# Notification Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `Notification` rows past a per-type retention period in a daily sweep (#223), and tell inbox readers that messages are kept for a year.

**Architecture:** A pure, compiler-tethered map from `NotificationType` to retention days lives in `src/lib/notification-retention.ts`. A sweep in `src/services/notification-retention.ts` reads each period's expired ids in bounded batches and deletes them by id. The sweep runs as one more step of the existing `daily-cleanup` scheduler job and its `/api/cron/daily-cleanup` mirror. A server-rendered caption under the teacher `/inbox` and student `/updates` lists states the policy.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (`unit`, `unit-sweeps`, `components` projects).

**Spec:** None. No spec was written; the direction was agreed in conversation and is recorded below. The pattern this follows is `src/services/waitlist-retention.ts` (#238).

## Decisions (agreed with the user, 2026-09-23)

- Option B from the #223 discussion: retention differs by type.
- **30 days:** `spot_available`, `missed_you`.
- **365 days:** every other `NotificationType`, including `reminder` and `waitlist_promoted`.
  - `waitlist_promoted` ("You are in") is the ONLY message an auto-promoted student receives (`promoteNext` in `src/services/waitlist.ts` creates no `booking_confirmed`), so it is a booking confirmation, not a transient alert.
  - `missed_you` is never created today (#661); it gets a period only because the map must be exhaustive.
- Read state does not matter: an unread row expires like a read one.
- Delete, no archive table.
- Runs inside the existing `daily-cleanup` job, not a new job.
- Inbox note copy, verbatim: `Messages are kept for a year.`, shown under the list on teacher `/inbox` and student `/updates` only. NOT on the `/bookings` unread strip, which also renders `NotificationList`.

## Global Constraints

- TypeScript `strict: true`; no `any`.
- `src/services/` is framework-agnostic: no Next.js imports in the sweep.
- `@/lib/log` is pino and server-only. `src/lib/notification-retention.ts` must NOT import it (the component test in Task 3 imports that file under jsdom).
- CLAUDE.md *Comment Discipline*: no counts or member rosters in comments; name the type. Membership is tethered with `satisfies Record<NotificationType, …>`.
- Stage exact paths; never `git add -A` / `git add .`. Quote paths containing `(student)` / `(teacher)`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- No migration: no schema change, no new index (see Task 1, "Why no index").

## Review Focus

1. **A new `NotificationType` added later without a retention period.** Expected: a compile error. The `satisfies` clause in Task 1 is that guard; Task 1 Step 7 mutation-tests it.
2. **`waitlist_promoted` put into the 30-day group by someone reasoning from the name.** Expected: a test fails. Task 1 pins it explicitly, with the reason.
3. **A large first-run backlog** (a deployment that has never swept). Expected: one run deletes at most a bounded number of rows per period, logs that it was capped, and the next run continues. Task 1 pins the cap.
4. **An unread row past its period.** Expected: deleted like a read one. Task 1 pins it.
5. **The note's copy drifting from the constant** (someone changes 365 to 730 and the page still says "a year"). Expected: a test fails beside the copy. Task 3 pins it.

---

### Task 1: Retention map and sweep

**Files:**
- Create: `src/lib/notification-retention.ts`
- Create: `src/lib/notification-retention.test.ts`
- Create: `src/services/notification-retention.ts`
- Create: `src/services/notification-retention.test.ts`
- Modify: `vitest.tiers.ts` (add the service test to `SWEEP_TESTS`)
- Modify (wording only): `CLAUDE.md` (Communication, item 2), `docs/data-model.md` (`### Notification (inbox item)`), `docs/information-architecture.md` (`### Tab 3: Inbox`), `src/services/notifications.ts` header line `2. In-app inbox (persistent record — this service)`, `src/services/email-fallback.ts` header line `2. In-app inbox (persistent record)`, `src/app/(student)/updates/page.tsx` (the comment above the component)

**Interfaces:**
- Produces (lib, pure):
  - `SHORT_RETENTION_DAYS: 30`
  - `STANDARD_RETENTION_DAYS: 365`
  - `NOTIFICATION_RETENTION_DAYS: { readonly [T in NotificationType]: 30 | 365 }`
- Produces (service):
  - `reapExpiredNotifications(db: PrismaClient, opts?: ReapNotificationOptions): Promise<NotificationReapSummary>`
  - `interface ReapNotificationOptions { now?: Date; batchSize?: number; maxBatches?: number }`
  - `interface NotificationReapSummary { deleted: number; periods: Array<{ days: number; cutoff: string; deleted: number; cappedOut: boolean }> }`

- [ ] **Step 1: Write the failing map test** — `src/lib/notification-retention.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { NotificationType } from '@prisma/client';
import {
  NOTIFICATION_RETENTION_DAYS,
  SHORT_RETENTION_DAYS,
  STANDARD_RETENTION_DAYS,
} from './notification-retention';

describe('NOTIFICATION_RETENTION_DAYS', () => {
  it('gives every NotificationType one of the two periods', () => {
    for (const type of Object.values(NotificationType)) {
      expect([SHORT_RETENTION_DAYS, STANDARD_RETENTION_DAYS]).toContain(
        NOTIFICATION_RETENTION_DAYS[type],
      );
    }
  });

  it('keeps spot_available briefly: it is useless once its claim window closes', () => {
    expect(NOTIFICATION_RETENTION_DAYS.spot_available).toBe(SHORT_RETENTION_DAYS);
  });

  it('keeps waitlist_promoted for the full period: it is the promoted student\'s only booking confirmation', () => {
    expect(NOTIFICATION_RETENTION_DAYS.waitlist_promoted).toBe(STANDARD_RETENTION_DAYS);
  });

  it('keeps reminder and payment_request for the full period', () => {
    expect(NOTIFICATION_RETENTION_DAYS.reminder).toBe(STANDARD_RETENTION_DAYS);
    expect(NOTIFICATION_RETENTION_DAYS.payment_request).toBe(STANDARD_RETENTION_DAYS);
  });
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `pnpm exec vitest run --project unit src/lib/notification-retention.test.ts`
Expected: FAIL, cannot resolve `./notification-retention`.

- [ ] **Step 3: Implement the map** — `src/lib/notification-retention.ts`

```ts
import type { NotificationType } from '@prisma/client';

/**
 * How long a `Notification` row is kept, by type (#223). Why deleting is
 * safe, and why there is no index for it: `docs/data-model.md`
 * (`### Notification (inbox item)`).
 *
 * Keep this module free of server-only imports; UI code imports it.
 */
export const SHORT_RETENTION_DAYS = 30;
export const STANDARD_RETENTION_DAYS = 365;

type RetentionDays = typeof SHORT_RETENTION_DAYS | typeof STANDARD_RETENTION_DAYS;

/**
 * `satisfies` makes a new `NotificationType` member a compile error here
 * until it is given a period.
 */
export const NOTIFICATION_RETENTION_DAYS = {
  booking_confirmed: STANDARD_RETENTION_DAYS,
  booking_cancelled: STANDARD_RETENTION_DAYS,
  booking_removed: STANDARD_RETENTION_DAYS,
  class_cancelled: STANDARD_RETENTION_DAYS,
  payment_received: STANDARD_RETENTION_DAYS,
  payment_request: STANDARD_RETENTION_DAYS,
  // A booking confirmation for an auto-promoted student, not a transient
  // alert: it is the only message that booking produces.
  waitlist_promoted: STANDARD_RETENTION_DAYS,
  // Worthless once its claim window has closed.
  spot_available: SHORT_RETENTION_DAYS,
  reminder: STANDARD_RETENTION_DAYS,
  missed_you: SHORT_RETENTION_DAYS,
  announcement: STANDARD_RETENTION_DAYS,
  teacher_invitation: STANDARD_RETENTION_DAYS,
} as const satisfies Record<NotificationType, RetentionDays>;
```

- [ ] **Step 4: Run it; expect pass**

Run: `pnpm exec vitest run --project unit src/lib/notification-retention.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing sweep test** — `src/services/notification-retention.test.ts`

Register the file in `vitest.tiers.ts` `SWEEP_TESTS` first (append after `'src/services/waitlist-retention.test.ts'`), so it runs in `unit-sweeps`: the sweep is database-wide. `recipientId` has no foreign key (it is polymorphic), so fixtures need no teacher or student. A per-run uuid recipient scopes everything.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type NotificationType } from '@prisma/client';
import { isTestDatabaseName } from '@/lib/worktree/identity';
import { reapExpiredNotifications } from './notification-retention';
import { scopeSweep } from '../../tests/scoped-sweep';

const prisma = new PrismaClient();
const RECIPIENT = randomUUID();
const NOW = new Date('2026-09-23T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

async function seed(type: NotificationType, createdAt: Date, isRead = true): Promise<string> {
  const row = await prisma.notification.create({
    data: {
      recipientType: 'student',
      recipientId: RECIPIENT,
      type,
      title: 't',
      body: 'b',
      isRead,
      createdAt,
    },
  });
  return row.id;
}

async function exists(id: string): Promise<boolean> {
  return (await prisma.notification.findUnique({ where: { id } })) !== null;
}

function scoped() {
  return scopeSweep(prisma, { Notification: { recipientId: RECIPIENT } });
}

beforeAll(async () => {
  // Refuse to run an unscoped DELETE sweep against a non-test database — the
  // same guard `waitlist-retention.test.ts` carries, for the same reason.
  const [row] =
    await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  const dbName = row?.current_database ?? '';
  if (!isTestDatabaseName(dbName)) {
    throw new Error(
      `[notification-retention.test] refusing to run an unscoped DELETE sweep against "${dbName}". ` +
        'Set DATABASE_URL_TEST to a database whose name ends in _test, or (in a worktree) _test_<slug>.',
    );
  }
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { recipientId: RECIPIENT } });
  await prisma.$disconnect();
});

describe('reapExpiredNotifications', () => {
  it('deletes a 365-day type past its period and keeps one inside it', async () => {
    const old = await seed('booking_confirmed', daysAgo(366));
    const fresh = await seed('booking_confirmed', daysAgo(364));
    const s = scoped();
    await reapExpiredNotifications(s.db, { now: NOW });
    expect(s.rowsRead('Notification')).toBeGreaterThan(0);
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('keeps a row exactly at the cutoff (strictly older is deleted)', async () => {
    const edge = await seed('announcement', daysAgo(365));
    await reapExpiredNotifications(scoped().db, { now: NOW });
    expect(await exists(edge)).toBe(true);
  });

  it('deletes spot_available after 30 days', async () => {
    const old = await seed('spot_available', daysAgo(31));
    const fresh = await seed('spot_available', daysAgo(29));
    await reapExpiredNotifications(scoped().db, { now: NOW });
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('keeps waitlist_promoted and reminder past 30 days', async () => {
    const promoted = await seed('waitlist_promoted', daysAgo(31));
    const reminder = await seed('reminder', daysAgo(31));
    await reapExpiredNotifications(scoped().db, { now: NOW });
    expect(await exists(promoted)).toBe(true);
    expect(await exists(reminder)).toBe(true);
  });

  it('deletes an unread row like a read one', async () => {
    const unread = await seed('class_cancelled', daysAgo(400), false);
    await reapExpiredNotifications(scoped().db, { now: NOW });
    expect(await exists(unread)).toBe(false);
  });

  it('stops at its batch cap, reports it, and the next run continues', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => seed('payment_received', daysAgo(500))),
    );
    const first = await reapExpiredNotifications(scoped().db, {
      now: NOW,
      batchSize: 2,
      maxBatches: 2,
    });
    const year = first.periods.find((p) => p.days === 365);
    expect(year?.deleted).toBe(4);
    expect(year?.cappedOut).toBe(true);

    const second = await reapExpiredNotifications(scoped().db, {
      now: NOW,
      batchSize: 2,
      maxBatches: 2,
    });
    expect(second.periods.find((p) => p.days === 365)?.deleted).toBe(1);
    for (const id of ids) expect(await exists(id)).toBe(false);
  });
});
```

- [ ] **Step 6: Run it; expect failure**

Run: `pnpm exec vitest run --project unit-sweeps src/services/notification-retention.test.ts`
Expected: FAIL, cannot resolve `./notification-retention`.

- [ ] **Step 7: Implement the sweep** — `src/services/notification-retention.ts`

```ts
import type { NotificationType, PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { NOTIFICATION_RETENTION_DAYS } from '@/lib/notification-retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1000;
const MAX_BATCHES_PER_PERIOD = 50;

export interface ReapNotificationOptions {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

export interface NotificationReapSummary {
  deleted: number;
  periods: Array<{ days: number; cutoff: string; deleted: number; cappedOut: boolean }>;
}

/** Types grouped by retention period, derived from the map. */
function typesByPeriod(): Map<number, NotificationType[]> {
  const groups = new Map<number, NotificationType[]>();
  for (const [type, days] of Object.entries(NOTIFICATION_RETENTION_DAYS) as Array<
    [NotificationType, number]
  >) {
    groups.set(days, [...(groups.get(days) ?? []), type]);
  }
  return groups;
}

/**
 * Deletes `Notification` rows older than their type's retention period (#223).
 *
 * Candidates are read with a top-level `findMany` and deleted by id, so
 * `tests/scoped-sweep.ts` can narrow both statements in a test. Each
 * `deleteMany` is its own statement: row locks last one batch, and the
 * `Class` rows these reference are never locked, because deleting a
 * referencing row takes no lock on the row it references.
 *
 * Bounded per run so a never-swept backlog cannot hold the daily job for
 * long; what is left waits for the next run, and `cappedOut` says so.
 * Errors propagate to `isolatedSweeps`: every batch already committed stays
 * deleted, and the next run picks up the rest.
 */
export async function reapExpiredNotifications(
  db: PrismaClient,
  opts: ReapNotificationOptions = {},
): Promise<NotificationReapSummary> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? MAX_BATCHES_PER_PERIOD;

  const periods: NotificationReapSummary['periods'] = [];
  for (const [days, types] of typesByPeriod()) {
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    let deleted = 0;
    let cappedOut = false;

    for (let batch = 0; ; batch++) {
      if (batch === maxBatches) {
        cappedOut = true;
        break;
      }
      const rows = await db.notification.findMany({
        where: { type: { in: types }, createdAt: { lt: cutoff } },
        select: { id: true },
        take: batchSize,
      });
      if (rows.length === 0) break;
      const { count } = await db.notification.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      deleted += count;
      if (rows.length < batchSize) break;
    }

    periods.push({ days, cutoff: cutoff.toISOString(), deleted, cappedOut });
  }

  const summary: NotificationReapSummary = {
    deleted: periods.reduce((sum, p) => sum + p.deleted, 0),
    periods,
  };
  if (periods.some((p) => p.cappedOut)) {
    log.warn(summary, 'notification retention hit its per-run cap; the rest waits for the next run');
  } else {
    log.info(summary, 'notification retention swept');
  }
  return summary;
}
```

Note the cap loop: with `maxBatches: 2` and 5 rows, batch 0 deletes 2, batch 1 deletes 2, batch 2 hits the cap → `cappedOut: true`, `deleted: 4`. When the last allowed batch happens to empty the backlog exactly, the run still reports `cappedOut: true`; that is acceptable (the next run finds nothing and reports false).

- [ ] **Step 8: Run the tests; expect pass**

Run: `pnpm exec vitest run --project unit-sweeps src/services/notification-retention.test.ts` and `pnpm exec vitest run --project unit src/lib/notification-retention.test.ts`
Expected: PASS.

- [ ] **Step 9: Prove the guards bite.** For each mutation: apply it, run, record the exact failure text in the task report, restore, and re-run to green. End with `git status` clean apart from this task's files.
  1. Delete the `missed_you` line from `NOTIFICATION_RETENTION_DAYS` → `pnpm exec tsc --noEmit` must fail naming `missed_you`.
  2. Change `waitlist_promoted` to `SHORT_RETENTION_DAYS` → the map test and the sweep's "keeps waitlist_promoted" test must fail.
  3. Change `lt: cutoff` to `lte: cutoff` → the "exactly at the cutoff" test must fail.
  4. Change `if (batch === maxBatches)` to `if (batch === maxBatches + 1)` → the cap test must fail.

- [ ] **Step 10: Correct the "persistent" wording.** Replace, do not annotate:
  - `CLAUDE.md` Communication list: `2. In-app inbox (persistent record)` → `2. In-app inbox (kept for a year; waitlist spot alerts for 30 days — \`src/lib/notification-retention.ts\`)`.
  - `docs/data-model.md`, under `### Notification (inbox item)`: change `in-app inbox (persistent)` to `in-app inbox (retained per type)`, and add one paragraph after the types line: rows are deleted by the daily `daily-cleanup` job once older than their type's period; periods live in `NOTIFICATION_RETENTION_DAYS` (`src/lib/notification-retention.ts`); `spot_available` and `missed_you` 30 days, everything else 365; read state does not matter. Also state, there, why deleting is safe (a row is the message about an event, never its record: `Payment`, `Registration` and `Announcement` hold those, and no code reads an old notification) and why there is no `createdAt` index (the "Why no index" paragraph at the end of this task, condensed).
  - `docs/information-architecture.md` Tab 3: `Persistent record of all notifications.` → `Everything from the past year; waitlist spot alerts for 30 days.`
  - `src/services/notifications.ts` and `src/services/email-fallback.ts` header lines: `persistent record` → `kept per NOTIFICATION_RETENTION_DAYS`.
  - `src/app/(student)/updates/page.tsx` comment: rewrite the two lines to say the page lists the student's notifications (the newest 50) for the retention period, the strip on `/bookings` previews unread.
  Then run `grep -rn -i "persistent record\|inbox (persistent\|keeps everything" CLAUDE.md docs/*.md src` and give every hit a verdict (docs under `docs/superpowers/` are historical records and stay).

- [ ] **Step 11: Commit**

```bash
git add src/lib/notification-retention.ts src/lib/notification-retention.test.ts src/services/notification-retention.ts src/services/notification-retention.test.ts vitest.tiers.ts CLAUDE.md docs/data-model.md docs/information-architecture.md src/services/notifications.ts src/services/email-fallback.ts "src/app/(student)/updates/page.tsx"
git commit -m "feat(notifications): per-type retention sweep (#223)"
```

**Why no index** (for the PR body, not a comment): the batch read filters on `(type, createdAt)`, which no index covers, so each batch is a sequential scan that stops once it has found `batchSize` matches. Old rows sit early in an append-mostly heap, so that is found quickly. An index on `createdAt` would be maintained by every notification insert, on the app's highest-write table, to speed up a query that runs once a day. The schema comment on `Notification` already makes this trade for the index #222 removed.

---

### Task 2: Wire the sweep into `daily-cleanup`

**Files:**
- Modify: `src/lib/scheduler.ts` (the sweeps interface near `reapClosedWaitlistEntries: (db: PrismaClient) => Promise<unknown>;`, the dynamic import, the object passing sweeps, and the `daily-cleanup` job's `isolatedSweeps` list)
- Modify: `src/lib/scheduler.test.ts` (`SWEEP_NAMES`, the `daily-cleanup` entry of the job-to-sweep map)
- Modify: `src/app/api/cron/daily-cleanup/route.ts`
- Modify: `src/app/api/cron/daily-cleanup/route.test.ts`
- Modify: `DEPLOYMENT.md` (the paragraph under `--fail` that says the route "runs three sweeps", and any list of body keys)

**Interfaces:**
- Consumes: `reapExpiredNotifications(db: PrismaClient, opts?): Promise<NotificationReapSummary>` from `@/services/notification-retention` (Task 1).
- Produces: route body key `notificationRetention: SweepOutcome<NotificationReapSummary>`.

- [ ] **Step 1: Write the failing tests.**
  - `scheduler.test.ts`: add `'reapExpiredNotifications'` to `SWEEP_NAMES`, and to the `daily-cleanup` array after `'reapClosedWaitlistEntries'` and before `'auditTeacherTimezones'` (which stays last for the reason its comment gives). Replace the comment's `Three sweeps, and the ORDER` with `The ORDER here is pinned without being load-bearing` and extend its "Nothing couples…" sentence to name notification retention too.
  - `route.test.ts`: add `const reapExpiredNotifications = vi.fn();`, a `vi.mock('@/services/notification-retention', …)` shaped like the others, `mockReset()` in `beforeEach`, a default `mockResolvedValue({ deleted: 0, periods: [] })` next to the audit's (same reason: an unmocked `vi.fn()` resolves `undefined`, which `settle` reports as success), `notificationRetention: { ok: boolean; error?: string }` in `Body`, `expect(body.data.notificationRetention.ok).toBe(true)` in the 200 case, and one new case:

```ts
it('answers non-2xx when notification retention fails, and the other sweeps still ran', async () => {
  cleanupExpiredAuth.mockResolvedValue({ sessions: 0 });
  reapClosedWaitlistEntries.mockResolvedValue({ deleted: 0, classes: 0 });
  reapExpiredNotifications.mockRejectedValue(new Error('boom'));

  const res = await POST(post());
  const body = (await res.json()) as Body;

  expect(res.status).toBe(500);
  expect(body.data.notificationRetention.ok).toBe(false);
  expect(body.data.auth.ok).toBe(true);
  expect(body.data.waitlistRetention.ok).toBe(true);
  expect(body.data.timezoneAudit.ok).toBe(true);
});
```
  Also fix `route.test.ts`'s header `With all three services mocked` → `With every sweep mocked`.

- [ ] **Step 2: Run; expect failure**

Run: `pnpm exec vitest run --project unit src/lib/scheduler.test.ts src/app/api/cron/daily-cleanup/route.test.ts`
Expected: FAIL (map mismatch; `notificationRetention` undefined).

- [ ] **Step 3: Implement.**
  - `scheduler.ts`: add `reapExpiredNotifications` beside `reapClosedWaitlistEntries` in the sweeps interface, the dynamic import (`await import('@/services/notification-retention')`), and the object that passes sweeps through; insert it into the `daily-cleanup` `isolatedSweeps` list after `reapClosedWaitlistEntries`. Replace `all three sweeps` (two places in the `daily-cleanup` comment) with `every sweep in this job`. Replace `either sweep above` with `any sweep above`, and `cleanupExpiredAuth or reapClosedWaitlistEntries` with `a sweep above it`.
  - `route.ts`: import it; after `waitlistRetention`, `const notificationRetention = await settle(() => reapExpiredNotifications(prisma));`; add it to the `respondOk` body and the `worstStatus` array. Update the header's service list (`auth-cleanup.test.ts`, `waitlist-retention.test.ts`) to add `notification-retention.test.ts`, which carries the same `_test` guard, so the header's argument against an e2e test covers it too. Replace `mocks all three`, `runs all three through`, and the body-key sentence (`read data.auth.ok, …`) with count-free wording that lists `data.notificationRetention.ok` as well. Leave `/api/cron/transition-classes already runs three` (it is about another route) and `the route ran two sweeps at the time` (a dated statement, still true).
  - `DEPLOYMENT.md`: `runs three sweeps` → `runs several sweeps`; add `notificationRetention` wherever body keys are listed.

- [ ] **Step 4: Run; expect pass**

Run: `pnpm exec vitest run --project unit src/lib/scheduler.test.ts src/app/api/cron/daily-cleanup/route.test.ts` and `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Prove the guards bite.** Record exact failure text; restore; re-run green; `git status` clean apart from this task's files.
  1. Remove `reapExpiredNotifications` from the `daily-cleanup` `isolatedSweeps` list → `scheduler.test.ts` must fail.
  2. Remove `notificationRetention` from the `worstStatus` array → the new route case must fail (status 200).

- [ ] **Step 6: Sweep for stale counts.** Run `grep -n -i "three\|both sweeps\|two sweeps" src/lib/scheduler.ts src/lib/scheduler.test.ts src/app/api/cron/daily-cleanup/route.ts src/app/api/cron/daily-cleanup/route.test.ts DEPLOYMENT.md` and give each hit a verdict in the report.

- [ ] **Step 7: Commit**

```bash
git add src/lib/scheduler.ts src/lib/scheduler.test.ts src/app/api/cron/daily-cleanup/route.ts src/app/api/cron/daily-cleanup/route.test.ts DEPLOYMENT.md
git commit -m "feat(notifications): run notification retention in daily-cleanup (#223)"
```

---

### Task 3: Inbox retention note

**Files:**
- Create: `src/components/layout/retention-note.tsx`
- Create: `src/components/layout/retention-note.test.tsx`
- Modify: `src/app/(teacher)/inbox/page.tsx`
- Modify: `src/app/(student)/updates/page.tsx`

**Interfaces:**
- Consumes: `STANDARD_RETENTION_DAYS` from `@/lib/notification-retention` (Task 1).
- Produces: `RetentionNote(): JSX.Element`.

- [ ] **Step 1: Write the failing test** — `src/components/layout/retention-note.test.tsx`

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { STANDARD_RETENTION_DAYS } from '@/lib/notification-retention';
import { RetentionNote } from './retention-note';

describe('RetentionNote', () => {
  it('states the policy', () => {
    render(<RetentionNote />);
    expect(screen.getByText('Messages are kept for a year.')).toHaveClass('type-caption');
  });

  it('says "a year" only while the period is one', () => {
    // The copy is fixed text; this ties it to the constant the sweep uses.
    expect(STANDARD_RETENTION_DAYS).toBe(365);
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm exec vitest run --project components src/components/layout/retention-note.test.tsx`
Expected: FAIL, cannot resolve `./retention-note`.

- [ ] **Step 3: Implement.**

`src/components/layout/retention-note.tsx` (no `'use client'`: both pages are server components):

```tsx
/** The inbox's retention policy, under the list (#223). */
export function RetentionNote() {
  return <p className="type-caption pt-4">Messages are kept for a year.</p>;
}
```

`src/app/(teacher)/inbox/page.tsx`: render `<RetentionNote />` directly after `<NotificationList notifications={notifications} />`.
`src/app/(student)/updates/page.tsx`: render `<RetentionNote />` directly after `<NotificationList … />`.
Do NOT add it to `NotificationList` itself: `/bookings` renders that component for its five-unread strip.

- [ ] **Step 4: Run; expect pass**

Run: `pnpm exec vitest run --project components src/components/layout/retention-note.test.tsx`
Expected: PASS.

- [ ] **Step 5: Prove the tether bites.** Change `STANDARD_RETENTION_DAYS` to `730` → the "a year" test must fail; record the text; restore.

- [ ] **Step 6: Look at it.** With the worktree app running (`pnpm run worktree:up`), open `/inbox` as a teacher and `/updates` as a student, at phone width, with an empty list and a non-empty one (recipes in `.claude/skills/verify/`). Check the caption sits under the last row, and under the empty state. Screenshot at 100%.

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/retention-note.tsx src/components/layout/retention-note.test.tsx "src/app/(teacher)/inbox/page.tsx" "src/app/(student)/updates/page.tsx"
git commit -m "feat(inbox): state the retention policy under the list (#223)"
```

---

## Before the PR

- `pnpm run verify` green (needs the worktree app up; see the solve-issue hazard list for `worktree:setup` / `worktree:up`).
- Whole-branch review (three tasks), one fix wave, one scoped re-review.
- PR body: the decisions above; the premise corrections (`waitlist_promoted` is a booking confirmation; `missed_you` is never sent, #661; the issue's "two code comments" claim no longer matches `src/`); "Why no index"; each guard's recorded mutation text; the `verify` arithmetic. **#157 and #177 are unaffected.**
