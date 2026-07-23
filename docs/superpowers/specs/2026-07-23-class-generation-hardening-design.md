# Class-generation hardening: atomic template creation + per-template isolation

**Date:** 2026-07-23
**Status:** Approved — autonomous run (issues #55 + #56). The one embedded
decision (#56's consistency-over-availability trade) is adopted per the issue's
recommendation and recorded below; the PR is the human review checkpoint.

## Problem

Two coupled defects in class-instance generation, both surfaced by PR #54's review:

- **#56 — non-atomic creation.** `POST /api/class-templates` commits the template, then runs *teacher-wide* generation as a separate step whose failure is **swallowed** (logged, still 201). This makes `template-without-instances` a representable state, which forced four accommodations now live on main: the swallow, an "accepted edge" (a re-activation failing moments before tonight's class loses it permanently), two "do not simplify" comments guarding the untestable catches, and a declined UI-honesty proposal. Same shape in the PATCH pause→active branch.
- **#55 — no per-template failure isolation.** In `generateClassInstances`, one template whose `class.create` throws a non-P2002 error aborts the whole loop (`throw err`), so every teacher's window stops being topped up. Because the scheduler's `class-generation` job awaits `generateClassInstances` before `generateStudioClassInstances`, a throw there starves studio generation too. Verified **latent, not live** (no deterministic trigger today), which is why it ships with a new failure-injection test rather than untested.

## Decision (re-confirmed)

**Consistency over availability for template creation.** A generator failure should block template creation with a visible, retryable error, not save a template that silently produces no classes. For a scheduling product, an error the teacher can see and retry beats a template that quietly generates nothing. This dissolves the swallow, the duplicate-template hazard (rollback leaves nothing to retry into), and the imminent-occurrence edge. Adopted per #56's own recommendation.

## Design

### 1. A template-scoped generator (`class-generator.ts`)

Extract the per-template body of `generateClassInstances` into:

```ts
export async function generateInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: TemplateWithTimezone, // ClassTemplate + { teacher: { defaultTimezone } }
  from?: Date,
): Promise<number>
```

It computes the 4-week window and creates the missing instances for **one** template (same date math, same `@@unique([templateId, date])` P2002-skip idempotency). Accepting `Prisma.TransactionClient` lets it run inside a `$transaction`.

`generateClassInstances(db, from?, teacherId?)` keeps its signature and its cron role (widen `db` to `PrismaClient | Prisma.TransactionClient`); its per-template loop now calls `generateInstancesForTemplate` **wrapped in try/catch** (#55): log `{ err, templateId, teacherId }`, continue, collect errors, rethrow the first at the end — the exact idiom the `class-transitions` scheduler job already uses. Per-template logging also retires the "templateId names the trigger, not the culprit" disclaimer (the sweep is now genuinely per-template).

### 2. Transactional routes (`class-templates/route.ts`, `class-templates/[id]/route.ts`)

**POST** — one transaction; the swallow catch and its "do not simplify" comment are deleted:
```ts
const template = await prisma.$transaction(async (tx) => {
  const created = await tx.classTemplate.create({
    data: { ... },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  await generateInstancesForTemplate(tx, created);
  return created;
});
return respondOk(stripTeacher(template), 201);
```
Failure propagates through `withErrorHandler` (500) instead of log-and-201. The teacher-room ownership check stays before the transaction.

**PATCH pause→active** — the toggle and the regeneration commit together, so a generation failure rolls the toggle back (template stays paused, retryable):
```ts
const updated = await prisma.$transaction(async (tx) => {
  const t = await tx.classTemplate.update({
    where: { id }, data: { isActive: !template.isActive },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (t.isActive) await generateInstancesForTemplate(tx, t);
  return t;
});
```
The archive branch and the archived-guard (409) are unchanged. Both routes drop their now-unused teacher-wide `generateClassInstances` import.

### 3. Scheduler isolation (`scheduler.ts`)

The `class-generation` job runs `generateClassInstances` then `generateStudioClassInstances` with no isolation, so #55's end-of-sweep rethrow would still starve studio generation. Wrap the two in the same per-sweep try/catch the `class-transitions` job uses (run both, log each failure, rethrow the first for job-health) so a class-template failure never starves studio classes.

## Testing

- **Unit (`class-generator.test.ts`) — per-template isolation (new pattern).** Dependency-inject a stub `db` (`as unknown as PrismaClient`) whose `classTemplate.findMany` returns two templates and whose `class.create` throws a non-P2002 error for the first template's rows only. Assert: the second template's instances are still created, `generateClassInstances` rethrows at the end, and the failure is logged with the failing `templateId`. This is the failure-injection pattern #55 asks the repo to adopt.
- **Integration (`class-templates-api.test.ts`) — transactional rollback (new).** Prove real rollback: inside a real `prisma.$transaction`, create a valid template, then call `generateInstancesForTemplate(tx, { ...created, teacherRoomId: <nonexistent uuid> })` so `class.create` hits a deterministic FK error (P2003, not the swallowed P2002); assert the transaction rejects and neither the template nor any instance persisted (`count` unchanged before/after). Uses the template-scoped path exactly as #56 specifies.
- **Existing suite carries over unchanged.** `generateClassInstances`'s signature is stable, so its 6 DB tests are unaffected. The two `class-templates-api` happy-path tests ("creates the template and its four-week window", "re-activation tops the window back up") still pass — success still 201s with the window present; only the *failure* path changed.

## Out of scope

- Studio-class generation internals (`generateStudioClassInstances`) — only its scheduler-level isolation is touched, not its logic.
- The `instancesCreated` response field (declined in #54 — success now means the window exists, no reporting needed).
- Any new unique constraint on `ClassTemplate` (rollback removes the duplicate-retry hazard, so none is needed).

## Verification

`tsc` + `eslint` clean; full `vitest` (incl. the two new tests) green; the class-generation Playwright coverage unaffected. The two "do not simplify" comments and both swallow catches are gone; a forced generation failure now 500s the create with nothing persisted.
