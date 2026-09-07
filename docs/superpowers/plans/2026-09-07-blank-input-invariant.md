# Blank Input Invariant — #405 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 22-field whitespace hole in `src/lib/schemas.ts` behind a test that makes a 23rd impossible, cover the `PUT /api/students/[id]` ownership gate, and clear the stale comments and swallowed logs #405 names.

**Architecture:** One derived test states a behavioural invariant — *a field that refuses the empty string must refuse a whitespace-only one too* — discovered by walking `Object.entries(schemas)` rather than a roster. Twenty-two fields gain `.trim()` to satisfy it. Three smaller tasks handle the integration coverage, the comment corrections, and the client logging.

**Tech Stack:** Zod 4.4.3, vitest (projects `unit`, `integration`, `components`), Prisma, Next.js App Router.

**Spec:** `docs/superpowers/specs/2026-09-07-blank-input-invariant-design.md`

## Global Constraints

- TypeScript `strict: true` — no `any`, no implicit types.
- Test-first: write the failing test, watch it fail, then implement.
- Never write a count or a member list in prose. Where membership matters, tether it (CLAUDE.md, *Comment Discipline*). A comment annotates the code it sits on; a claim about another file goes in `docs/` or nowhere.
- Never `git add -A` or `git add .` — stage exact paths.
- The dev server on `:3000` is the user's. Do not kill, restart, or rebuild it. The `integration` project needs it live.
- Fast inner loops: `npx vitest run --project unit src/lib/schemas.test.ts`, `npx vitest run --project components <path>`, `npx vitest run --project integration <path>`.

---

### Task 1: The blank-input invariant, and the 22 trims

**Files:**
- Modify: `src/lib/schemas.test.ts` — add the invariant block; delete two superseded tests from the `#311` block at `:702`
- Modify: `src/lib/schemas.ts` — 22 occurrences of `z.string().min(1)`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PUT /api/students/[id]` with `firstName: "   "` now answers **400**. Task 2 asserts that over HTTP.

**Background the implementer needs.** Zod's `.trim()` is a *transform*, not a check, and transforms run before checks. `z.string().trim().min(1)` therefore refuses `"   "`, while `z.string().min(1)` accepts it and stores three spaces. Order matters: `z.string().min(1).trim()` would still accept it and merely store `""`.

- [ ] **Step 1: Write the failing test**

Append this block to the very end of `src/lib/schemas.test.ts`. The file already imports `z` from `zod` and `* as schemas from './schemas'` — reuse those imports rather than adding new ones.

```ts
/**
 * A field that refuses a blank value must refuse one made of whitespace too.
 *
 * Derived from the module, never a roster: every exported schema is walked,
 * so one added tomorrow is covered the moment it is exported. That is the
 * whole reason this exists rather than a fourth hand-written list of schema
 * names.
 *
 * The rule reads behaviour, not syntax. It never looks for `.min(1)`, so a
 * field guarded another way passes untouched — `pageSlugField`'s
 * `^[a-z0-9-]+$` refuses whitespace with no `.trim()` at all. And a field
 * that legitimately accepts a blank value (`bio`, `notes`, a nullable
 * `phone`) exempts itself by accepting `''`. There is no allowlist here,
 * which is the point: nothing exists for a later change to add an
 * exception to.
 *
 * Scope: top-level fields. An array field's element schema is not walked, so
 * `z.array(z.string())` accepting `['   ']` is outside what this proves.
 */
describe('a field that refuses blank refuses whitespace too (#405)', () => {
  /**
   * The last entry is a non-breaking space — what a paste from a web page or
   * an Option+Space on a Mac actually produces. `String.prototype.trim()`
   * strips it, so a trimmed field rejects it; an untrimmed one stores it.
   */
  const BLANKS = ['   ', '\t\n  ', ' '] as const;

  function shapeOf(schema: unknown): Record<string, z.ZodType> | undefined {
    return (
      (schema as { shape?: Record<string, z.ZodType> }).shape ??
      (schema as { _def?: { schema?: { shape?: Record<string, z.ZodType> } } })._def?.schema
        ?.shape
    );
  }

  function sweep(): { offenders: string[]; checked: string[] } {
    const offenders: string[] = [];
    const checked: string[] = [];
    const visit = (label: string, field: z.ZodType): void => {
      if (field.safeParse('').success) return; // blank is legal here — exempt
      checked.push(label);
      for (const blank of BLANKS) {
        if (field.safeParse(blank).success) {
          offenders.push(`${label} accepts ${JSON.stringify(blank)}`);
        }
      }
    };
    for (const [name, schema] of Object.entries(schemas)) {
      if (!(schema instanceof z.ZodType)) continue;
      const shape = shapeOf(schema);
      if (shape) {
        for (const [key, field] of Object.entries(shape)) visit(`${name}.${key}`, field);
      } else {
        visit(name, schema); // a bare field export, e.g. `pageSlugField`
      }
    }
    return { offenders, checked };
  }

  it('holds for every field of every exported schema', () => {
    expect(sweep().offenders).toEqual([]);
  });

  /**
   * A floor, deliberately not a census. The failure mode of a discovery loop
   * is silence: if `Object.entries` stopped yielding schemas, or `shapeOf`
   * stopped reading a shape, the test above would report no offenders and
   * pass green while proving nothing. This is the assertion that notices.
   * Set well below the real number so growth never touches it.
   */
  it('actually visited the schemas', () => {
    expect(sweep().checked.length).toBeGreaterThanOrEqual(90);
  });
});
```

The floor of 90 is grounded: the sweep currently visits **141** fields across 38 object schemas and one bare field export (`pageSlugField`). Breaking `shapeOf` collapses that to 1. Put the 141 in the commit message, not in the comment — a measured number belongs where it has an owner.

- [ ] **Step 2: Run it and record the RED**

Run: `npx vitest run --project unit src/lib/schemas.test.ts`

Expected: the first test FAILS with **66 lines — 22 distinct fields × 3 blank forms**. Copy the failure output into the task's report. The 22:

`magicLinkVerifySchema.token`, `passkeyAuthVerifySchema.challengeId`, `teacherProfileSchema.firstName`, `teacherProfileSchema.lastName`, `studentProfileSchema.firstName`, `studentProfileSchema.lastName`, `updateTeacherSchema.firstName`, `updateTeacherSchema.lastName`, `createInvitationSchema.firstName`, `updateInvitationSchema.firstName`, `updateStudentSchema.firstName`, `updateStudentSchema.lastName`, `createRoomSchema.venueName`, `createRoomSchema.address`, `createRoomSchema.city`, `createRoomSchema.postcode`, `updateRoomSchema.venueName`, `updateRoomSchema.address`, `updateRoomSchema.city`, `updateRoomSchema.postcode`, `markPaidSchema.method`, `createAnnouncementSchema.message`.

**If the RED set differs from that list, stop and report it rather than adjusting either side.** The list was measured; a difference means something changed under this plan.

- [ ] **Step 3: Trim the 22**

In `src/lib/schemas.ts`, replace every occurrence of the exact string `z.string().min(1)` with `z.string().trim().min(1)`. There are exactly 22, and the replacement is total — verify before and after:

```bash
grep -o "z\.string()\.min(1)" src/lib/schemas.ts | wc -l        # 22 before, 0 after
grep -o "z\.string()\.trim()\.min(1)" src/lib/schemas.ts | wc -l # 12 before, 34 after
```

`pageSlugField` is untouched by construction: its `.min(1)` sits on its own line after a `.string()` on the line above, so it does not match the literal. Do not add `.trim()` to it — its regex already refuses whitespace, and the invariant asks nothing more.

Do not introduce a shared `requiredText` constant. The 12 pre-existing sites use inline `.trim()` and a constant would churn them for no behavioural gain; the test above, not a constant, is what stops the next hand-written `z.string().min(1)`.

- [ ] **Step 4: Run it and see GREEN**

Run: `npx vitest run --project unit src/lib/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Supersede the two rejection tests the invariant now covers**

The block `describe('classType and location whitespace trimming and validation (#311)')` at `src/lib/schemas.test.ts:702` holds six `it` declarations. Delete exactly two:

- `it.each(classTypeSchemas)('%s rejects empty and whitespace-only classType', …)`
- `it.each(locationSchemas)('%s rejects empty and whitespace-only location', …)`

Keep the other four — the two census tests (`covers exactly the eight schemas carrying classType`, and its `location` twin) assert *which schemas carry the field*, which the invariant says nothing about; the two trim tests assert padding is stripped before storage (`'  Vinyasa Flow  '` → `'Vinyasa Flow'`), which the invariant also does not say.

In place of the deleted pair, leave one comment inside the block explaining what moved and why, along these lines — the reason matters more than the fact:

```ts
// Whitespace rejection is no longer asserted per-schema here: the #405
// invariant at the end of this file covers every field of every exported
// schema, including these. What stays is what that invariant cannot say —
// which schemas carry these fields at all, and that padding is stripped
// before storage rather than merely rejected.
```

Do not delete the `classTypeSchemas` / `locationSchemas` arrays: the four surviving tests still use them.

- [ ] **Step 6: Run the whole unit project**

Run: `npx vitest run --project unit`
Expected: PASS. If a test elsewhere asserted that some field accepted a padded value, that is a real behaviour change — report it, do not silence it.

- [ ] **Step 7: Prove the invariant bites**

Two mutations, each: apply, run, record the **exact** failure text, restore, re-run to confirm green.

1. **A field the plan never told it about.** Remove `.trim()` from `createRoomSchema.city` only — deliberately not one of the two fields #405 names, so the tether is proven against a field it was never pointed at. Expected: the first test fails naming `createRoomSchema.city`.
2. **The floor guard.** Make `shapeOf` return `undefined` unconditionally. Expected: the second test fails on the floor. This proves the guard against a silently-empty sweep is itself real — without it, mutation 2 would leave both tests green.

Record both failure texts verbatim in the task report. A pin that compiles but cannot fail certifies nothing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts
git commit -m "fix(schemas): a blank value is a blank value, whatever it is made of (#405)"
```

The message body should carry: the 22-field list is measured not guessed; the arithmetic `35 .min(1) sites − 12 already trimmed = 23, minus pageSlugField (guarded by its regex) = 22`; the measured `checked` count behind `FLOOR`; and both mutation results.

---

### Task 2: Cover the `PUT /api/students/[id]` ownership gate

**Files:**
- Modify: `tests/integration/students-api.test.ts` — new `describe` block at the end

**Interfaces:**
- Consumes: Task 1's trims — case 3 asserts the 400 they create. **Task 1 must land first.**
- Produces: nothing later tasks use.

**Background.** The route's gate is `if (session.studentId === id)` at `src/app/api/students/[id]/route.ts:71`; anything else falls through to `respondError('Access denied', 403)`. It is correct today. The whole suite currently makes two `PUT /api/students/…` requests, both in `tests/integration/tier-selected-at.test.ts`, both as the owning student — so nothing proves another student cannot rewrite your name.

There is no rate limiter on this route, so no `freshIp()` juggling is needed. The file's existing fixtures create students *without* accounts; this block needs two students that each have an `Account` and a `Session`, so it brings its own.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/students-api.test.ts`. Add `teardownStudent` to the existing `../helpers` import line (it currently imports `BASE_URL, cookie, uniqueSuffix, seedSession, waitFor`).

```ts
/**
 * The PUT gate, from the outside. `session.studentId === id` is the only
 * thing standing between one student and another's stored name, and until
 * #405 no test made a cross-student attempt at all.
 *
 * Own fixtures: the students seeded at the top of this file have no
 * `Account`, so none of them can hold a session to make this request with.
 */
describe('PUT /api/students/[id]', () => {
  type Owner = { id: string; token: string; accountId: string };
  let alice: Owner;
  let bob: Owner;

  async function mkClaimedStudent(name: string): Promise<Owner> {
    const email = `putown-${name}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: name,
        lastName: 'Owner',
        email,
        account: { create: { email } },
        claimedAt: new Date(),
      },
    });
    const token = await seedSession(prisma, student.accountId!);
    return { id: student.id, token, accountId: student.accountId! };
  }

  async function put(id: string, body: Record<string, unknown>, token: string) {
    return fetch(`${BASE_URL}/api/students/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    });
  }

  async function firstNameOf(id: string): Promise<string> {
    const row = await prisma.student.findUniqueOrThrow({
      where: { id },
      select: { firstName: true },
    });
    return row.firstName;
  }

  beforeAll(async () => {
    alice = await mkClaimedStudent('alice');
    bob = await mkClaimedStudent('bob');
  });

  afterAll(async () => {
    await teardownStudent(prisma, alice?.id, alice?.accountId);
    await teardownStudent(prisma, bob?.id, bob?.accountId);
  });

  it("refuses one student's edit of another's name, and writes nothing", async () => {
    const res = await put(bob.id, { firstName: 'Rewritten' }, alice.token);
    expect(res.status).toBe(403);
    // The status alone would pass against a route that answered 403 after
    // writing. This is the assertion that makes the gate mean something.
    expect(await firstNameOf(bob.id)).toBe('bob');
  });

  it('allows a student to edit their own name', async () => {
    const res = await put(alice.id, { firstName: 'Alicia' }, alice.token);
    expect(res.status).toBe(200);
    expect(await firstNameOf(alice.id)).toBe('Alicia');
  });

  it('refuses a whitespace-only first name (#405 §1, over the wire)', async () => {
    const res = await put(alice.id, { firstName: '   ' }, alice.token);
    expect(res.status).toBe(400);
    expect(await firstNameOf(alice.id)).toBe('Alicia');
  });
});
```

The second test is not padding. Without it, the 403 case would pass unchanged against a route that rejected every `PUT` from anyone — it is what makes the first test about *ownership* rather than about the endpoint being broken.

- [ ] **Step 2: Run and verify all three pass**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts`
Expected: PASS. Requires the dev server live on `:3000` — do not start or restart one if it is already running.

- [ ] **Step 3: Prove the ownership test bites**

Mutate the route: in `src/app/api/students/[id]/route.ts`, change the `PUT` gate from `session.studentId === id` to `Boolean(session.studentId)` — the realistic regression, a gate that checks *a* student is signed in rather than *the* student. Re-run. Expected: the first test fails, on the status or on Bob's name.

Record the exact failure text, then restore and re-run to confirm green. **Restore by editing the line back, not with `git checkout`** — a checkout of that file would discard nothing here, but the habit costs sibling edits elsewhere.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/students-api.test.ts
git commit -m "test(students): cover the PUT ownership gate on names (#405)"
```

---

### Task 3: Correct five docblocks and one page comment

**Files:**
- Modify: `src/components/student/tier-form.tsx:27-31`
- Modify: `src/components/student/notifications-form.tsx:24-32`
- Modify: `src/components/student/name-form.tsx:25-28`
- Modify: `src/components/student/tier-form.test.tsx:5-13`
- Modify: `src/components/student/notifications-form.test.tsx:5-14`
- Modify: `src/app/(student)/account/page.tsx:20`

**Interfaces:**
- Consumes: nothing. Independent of Tasks 1, 2 and 4.
- Produces: nothing.

**Background — and a correction to the issue.** #405 §3 names three component docblocks. Two more carry the same drift, and one of them is *already wrong*:

`notifications-form.test.tsx:5-14` says "the schema has eight keys, `tier-form.tsx` sends a third, and five have no student-facing input anywhere." `updateStudentSchema` does have eight keys. But **"five" is now three**: `firstName` and `lastName` gained a student-facing form in #403 (`name-form.tsx`), leaving only `phone`, `birthday` and `address` without one. Verified — nothing under `src/app/(student)` or `src/components/student` renders an input for any of those three. The docblock was true when written and #403 invalidated it without touching it, which is exactly the failure §3 is about.

Do not fix the number. Per CLAUDE.md, *never write a count or a member list in prose* — remove the count and state what is durable instead. Correct by **replacing**, never by annotating: no "this previously read five". The before-and-after belongs in the PR body.

The durable fact each of these docblocks is reaching for: `updateStudentSchema` is `.strict()`, so a key a form sent that the schema had dropped would 400 at runtime, and the reverse pin catches that at compile time. That needs no sibling roster and no count to make its point.

- [ ] **Step 1: Rewrite the three component docblocks**

Each becomes self-contained — its own issue numbers, its own reason, no sibling named, and no pointer to another file for the reasoning. `tier-form.tsx` currently ends "See that file for why there is no forward pin"; that cross-file pointer goes with the roster.

`src/components/student/tier-form.tsx`:

```tsx
/**
 * #136. Reverse pin only: `updateStudentSchema` is `.strict()`, so a key
 * this form sent that the schema had dropped would 400 at runtime, and this
 * catches it at compile time instead. No forward pin — the schema carries
 * fields this form has no business rendering.
 */
```

`src/components/student/notifications-form.tsx`:

```tsx
/**
 * #136, #400. Reverse pin only: `updateStudentSchema` is `.strict()`, so a
 * key this form sent that the schema had dropped would 400 at runtime, and
 * this catches it at compile time instead. No forward pin — the schema
 * carries fields this form has no business rendering.
 */
```

`src/components/student/name-form.tsx`:

```tsx
/**
 * #400. Reverse pin only: `updateStudentSchema` is `.strict()`, so a key
 * this form sent that the schema had dropped would 400 at runtime, and this
 * catches it at compile time instead. No forward pin — the schema carries
 * fields this form has no business rendering.
 */
```

- [ ] **Step 2: Rewrite the two test docblocks**

`src/components/student/tier-form.test.tsx` — drop the "Like `notifications-form.tsx`… see that file's comment" pointer, keep what this file actually holds:

```tsx
/**
 * #136. The reverse pin in `tier-form.tsx` proves its key is one
 * `updateStudentSchema` accepts, but cannot see what reaches the API. That
 * is what these tests hold: the exact key set sent, and that picking a
 * different tier changes the value sent.
 *
 * Nothing fetches on mount, so the save click is the first (and only) call.
 */
```

`src/components/student/notifications-form.test.tsx` — the count and the cross-file roster go; the reason for having no forward pin stays, stated without enumerating anything:

```tsx
/**
 * #136. The reverse pin in `notifications-form.tsx` proves its keys are ones
 * `updateStudentSchema` accepts, but cannot see what reaches the API. That is
 * what these tests hold: the exact key set sent, and that all four reminder
 * options — produced from `REMINDER_OPTIONS` rather than inline JSX — render.
 *
 * No forward pin on the form: the schema carries fields no student-facing
 * input renders, and a forward pin would name them.
 *
 * Nothing fetches on mount, so the save click is the first (and only) call.
 */
```

- [ ] **Step 3: Correct the page comment**

`src/app/(student)/account/page.tsx:20` reads:

```tsx
// The student settings index: personal details + one row per area, teacher-settings pattern.
```

`src/app/(teacher)/settings/page.tsx` has no inline form, so "teacher-settings pattern" is a claim about another file, and a false one. The layout does not change — only the comment:

```tsx
// The student settings index: personal details inline, then one row per
// settings area, then sign-in.
```

- [ ] **Step 4: Verify nothing broke**

Run: `npx vitest run --project components src/components/student src/app/\(student\)` and `npm run typecheck`
Expected: PASS. These are comment-only edits, so a failure means a real edit slipped in.

- [ ] **Step 5: Sweep for what was invalidated, not what was edited**

Grep for the claims just removed, across source, tests, docs, and the spec and plan in `docs/superpowers/`:

```bash
grep -rn "teacher-settings pattern" src/ docs/
grep -rn "notifications-form\|tier-form\|name-form" src/ docs/ --include="*.tsx" --include="*.ts" --include="*.md"
```

Give every hit a verdict — expect legitimate survivors (imports, file paths, this plan). Report any remaining prose that names a sibling form or counts schema keys.

- [ ] **Step 6: Commit**

```bash
git add src/components/student/tier-form.tsx src/components/student/notifications-form.tsx src/components/student/name-form.tsx src/components/student/tier-form.test.tsx src/components/student/notifications-form.test.tsx "src/app/(student)/account/page.tsx"
git commit -m "docs(student-forms): drop the sibling rosters and the stale key count (#405)"
```

Note the quoted path — `(student)` unquoted is a zsh glob that silently matches nothing.

---

### Task 4: Log the swallowed network failures, and prove each log fires

**Files:**
- Modify: `src/components/student/tier-form.tsx:60-62`
- Modify: `src/components/student/name-form.tsx:72-74`
- Modify: `src/components/student/notifications-form.tsx:99-101`
- Modify: `src/components/student/tier-form.test.tsx`
- Modify: `src/components/student/name-form.test.tsx`
- Modify: `src/components/student/notifications-form.test.tsx`

**Interfaces:**
- Consumes: nothing. Independent of Tasks 1 and 2. **If Task 3 has already run, its docblock rewrites are in these same files — rebase or apply on top rather than reverting them.**
- Produces: nothing.

**Background.** All three forms currently write `} catch { setError('Network error. Try again.'); }` — the error is discarded unbound, so there is nothing to log without editing the line. `src/lib/log.ts`'s own docblock says client components use `console.*` (the module is pino and server-only). The established analogues are `class-edit-form.tsx:139-145` and `studio-class-edit-form.tsx:195-201`.

**Say this plainly and do not overstate it:** 48 non-test `.tsx` files carry at least one bare `} catch {`; 13 log. These three are three of the 48. This task does not make the codebase consistent and the PR body must not imply that it does.

**What actually reaches each block differs, so the three comments differ.** `name-form.tsx` delegates body reading to `readErrorMessage`, which catches its own parse failure and returns the fallback rather than throwing — so only `fetch` itself failing lands in its `catch`. `tier-form.tsx` and `notifications-form.tsx` never read the body at all, so the same is true of them for a different reason. Do not paste one comment into all three.

- [ ] **Step 1: Write the three failing tests**

Add to each of the three test files. `name-form.test.tsx` already has `stubFetch`; the other two do too. Each needs a *rejecting* stub, which none of them has.

For `src/components/student/name-form.test.tsx`:

```tsx
it('logs the failure and tells the student when fetch itself fails', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock.mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <NameForm studentId="student-1" initialFirstName="Anna" initialLastName="Smith" />,
  );

  fireEvent.click(screen.getByRole('button', { name: /save name/i }));
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent('Network error. Try again.');
  });
  // The copy alone would pass with the error still discarded. This is the
  // assertion that makes the log a change rather than a gesture.
  expect(logged).toHaveBeenCalled();
  logged.mockRestore();
});
```

For `src/components/student/tier-form.test.tsx` — this form renders its error in a plain `<p>`, not a `role="alert"`, so assert on the text; the button is `/save tier/i`:

```tsx
it('logs the failure and tells the student when fetch itself fails', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock.mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  render(<TierForm studentId="student-1" currentTier={3} />);

  fireEvent.click(screen.getByRole('button', { name: /save tier/i }));
  await waitFor(() => {
    expect(screen.getByText('Network error. Try again.')).toBeInTheDocument();
  });
  expect(logged).toHaveBeenCalled();
  logged.mockRestore();
});
```

For `src/components/student/notifications-form.test.tsx` — button `/save notifications/i`; give the component the props its other tests give it:

```tsx
it('logs the failure and tells the student when fetch itself fails', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock.mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <NotificationsForm studentId="student-1" emailNotifications reminderPref="eve" />,
  );

  fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
  await waitFor(() => {
    expect(screen.getByText('Network error. Try again.')).toBeInTheDocument();
  });
  expect(logged).toHaveBeenCalled();
  logged.mockRestore();
});
```

Check each file's existing `render(...)` calls for the exact prop values its other tests use, and match them rather than inventing new ones.

- [ ] **Step 2: Run them and verify each fails on the log assertion**

Run: `npx vitest run --project components src/components/student`
Expected: three FAILs, each on `expect(logged).toHaveBeenCalled()` — **not** on the error copy. A failure on the copy means the stub or the selector is wrong, not that the log is missing. Report which line each failed on.

- [ ] **Step 3: Bind and log in the three forms**

`src/components/student/name-form.tsx` — replace `} catch {`:

```tsx
} catch (err) {
  // Bound and logged rather than discarded. Only `fetch` itself failing
  // reaches here — offline, DNS, an aborted connection: `readErrorMessage`
  // handles its own unreadable body and returns the fallback copy instead
  // of throwing.
  console.error('student name save failed', err);
  setError('Network error. Try again.');
}
```

`src/components/student/tier-form.tsx`:

```tsx
} catch (err) {
  // Bound and logged rather than discarded. This form never reads the
  // response body, so what reaches here is `fetch` itself failing —
  // offline, DNS, an aborted connection — and without the log nothing
  // records which.
  console.error('student tier save failed', err);
  setError('Network error. Try again.');
}
```

`src/components/student/notifications-form.tsx`:

```tsx
} catch (err) {
  // Bound and logged rather than discarded. This form never reads the
  // response body, so what reaches here is `fetch` itself failing —
  // offline, DNS, an aborted connection — and without the log nothing
  // records which.
  console.error('student notification prefs save failed', err);
  setError('Network error. Try again.');
}
```

- [ ] **Step 4: Run and see GREEN**

Run: `npx vitest run --project components src/components/student`
Expected: PASS.

- [ ] **Step 5: Prove each log assertion bites**

Remove the `console.error` line from `tier-form.tsx` only. Re-run. Expected: exactly one test fails — the tier one — and the other two stay green. That is what shows the three assertions are independent rather than one of them covering all three. Record the failure text, restore, re-run green.

- [ ] **Step 6: Commit**

```bash
git add src/components/student/tier-form.tsx src/components/student/name-form.tsx src/components/student/notifications-form.tsx src/components/student/tier-form.test.tsx src/components/student/name-form.test.tsx src/components/student/notifications-form.test.tsx
git commit -m "fix(student-forms): log the network failures all three swallowed (#405)"
```

---

## After all four tasks

- [ ] **Whole-branch review** on the most capable model, then one fix wave, then one scoped re-review. Four tasks means cross-task blindness is real: Tasks 3 and 4 edit the same six files, and Task 2's third case depends on Task 1's behaviour change.
- [ ] **`npm run verify`** — typecheck, lint, and every vitest project. Needs the app live on `:3000`. Report the arithmetic that shows the integration tier ran, and remember that `npm test` chains with `&&`: while anything earlier is red, the integration project reports *nothing*, not zero failures.
- [ ] **Push, open the PR, run `/pr-review-toolkit:review-pr`.**
