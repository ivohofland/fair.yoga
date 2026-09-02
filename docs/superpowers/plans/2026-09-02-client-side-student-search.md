# Client-side student search and pagination (issue #176) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the `?search=` oracle in issue #176 by *deleting* the server-side
search rather than gating it. `GET /api/students` stops accepting a search term
and stops paginating; it returns every student linked to the requesting teacher,
each already through `projectStudentForTeacher`. The directory fetches that once
and does search and pagination in the browser.

**Architecture:** The leak is that `where` filters on raw `firstName`/`lastName`/
`email` while the response redacts them, so hit/miss and `total` answer questions
about columns the teacher may not read. Every alternative (see the issue) fixes
this by making a server predicate *mirror* `projectStudentForTeacher`, leaving a
mirror that must stay true forever. Deleting the parameter removes the question:
the server never receives the query, so there is no predicate to keep correct and
no `total` to read. The client filters `displayName` and `email` — the projection's
own output — so the searched bytes *are* the rendered bytes by construction.

**Tech Stack:** TypeScript strict, Next.js App Router route handlers, Prisma 6,
React 19 client components, Vitest (`components` + `integration` projects).

**Spec:** None. Issue #176's body is the spec — it carries the decision, the
alternatives ruled out with their specific defects, the file-by-file scope and the
acceptance criteria. Gated at the session's spec gate: one reasonable design
remains, no data-model or invariant change, nothing touching money, auth or
concurrent state.

## What was measured before planning

Verified on this branch on 2026-09-02, correcting three claims the issue body
made before this sweep (the issue has since been corrected; see its Tests block):

- **`?search=` has exactly one production caller** — `student-directory.tsx:53`.
  `add-walk-in.tsx:38` calls the same endpoint but passes only `page`/`pageSize`.
  Re-derive:
  ```sh
  grep -rn "api/students?" src --include="*.ts" --include="*.tsx" | grep -v "api/students/"
  ```
- **`studentListQuerySchema` is `search` + `page` + `pageSize` and nothing else**
  (`src/lib/schemas.ts:288-292`), so removing all three empties it. `archived` is
  read from raw params (`params.archived === 'true'`), not from the schema, which
  is why the route needs no schema at all afterwards.
- **`total` has exactly two consumers**: `student-directory.tsx:61` (`setTotal` →
  `totalPages`) and `add-walk-in.tsx:47` (`rosterTotal` → the truncation notice at
  `:106-107`).
- **`student-directory.test.tsx` has no search or pagination assertions** — 130
  lines, two tests, both about rendering. Only the mock shape at `:35` changes.
- **No e2e spec drives the search box or the pager.** `invitations.spec.ts` visits
  `/students` only for Contacts rows.
- **The teacher fixture in `students-api.test.ts` holds 25 students**, so
  `toHaveLength(10)` assertions become `toHaveLength(25)`.
- **`Pagination` (`src/components/students/pagination.tsx`) needs no change** — it
  is generic over `currentPage`/`totalPages`/`onPageChange` and returns `null` at
  `totalPages <= 1`.

### Two comments this change invalidates that no diff-keyed sweep would find

1. `src/app/api/invitations/route.ts:20-24` — "No pagination, **unlike** GET
   /api/students… `studentListQuerySchema` (schemas.ts) is the idiom to copy."
   Both halves die: the contrast becomes false and the symbol stops existing.
   After this change both routes return an unpaginated list, so the contrast
   collapses rather than inverting.
2. `tests/integration/students-api.test.ts:721-727` — names `filters by search
   term (name)` and `maps counts to the right rows across a full page` **by
   title** as the #167 mutation check. The first is deleted here; the second's
   name goes stale once there are no pages.

Re-derive both with a sweep on what is being *removed*, not on the diff:
```sh
grep -rn "studentListQuerySchema\|pageSize\|filters by search term" src tests docs --include="*.ts" --include="*.tsx" --include="*.md"
```

## Global Constraints

- TypeScript `strict: true` — no `any`, no implicit types.
- Comment Discipline (CLAUDE.md): a comment annotates the code it sits on.
  Correct a claim by **replacing** it, never by annotating it with what it used
  to say — the before/after belongs in the PR body.
- No migration. This plan touches no schema.
- **Task order is load-bearing.** Task 1 lands the server change; between Task 1
  and Task 2 the real app renders every student under a pager computed from an
  absent `total`. The test suite stays green throughout — the component tests
  mock `fetch` and define their own response — but do not reorder these, and do
  not judge the branch's UI state from a mid-branch commit.
- **This worktree cannot run `integration` or `e2e` locally** — both need the dev
  server on `:3000` and the shared dev DB, which a worktree has neither of. Scope
  local verification to `--project unit` and `--project components`; push and cite
  the CI run for the integration tier.
- Never kill or restart anything on `:3000`.

---

### Task 1: Delete server-side search and pagination from `GET /api/students`

**Files:**
- Modify: `src/app/api/students/route.ts` — the `GET` handler only (`:10-84`); the
  `POST` handler below it is untouched
- Modify: `src/lib/schemas.ts` — delete `studentListQuerySchema` (`:288-292`)
- Modify: `src/app/api/invitations/route.ts` — the comment at `:20-24`
- Test: `tests/integration/students-api.test.ts` — the `describe('GET
  /api/students')` block (`:85-142`), the dual-role assertion at `:728`, the
  `fetchSingleStudent` helper at `:856`, `maps counts…` at `:881`, and the
  comment at `:721-727`

**Interfaces:**
- Produces: the response shape `{ students }` — Tasks 2 and 3 both consume it.
  `total`, `page` and `pageSize` are gone from the body.
- Consumes: nothing from another task.

- [ ] **Step 1: Write the failing test (the tether)**

Add to the `describe('GET /api/students')` block. This is the assertion that
makes reinstating server-side filtering fail, and it is the issue's second
acceptance criterion. It asserts on the *whole body*, not on `total` alone,
because `total` will no longer exist.

```ts
  it('ignores a search parameter entirely — the same body with, without, and for a withheld surname', async () => {
    const [plain, withheld, garbage] = await Promise.all([
      fetch(`${BASE_URL}/api/students`, { headers: cookie(teacherToken) }),
      fetch(`${BASE_URL}/api/students?search=Student00`, { headers: cookie(teacherToken) }),
      fetch(`${BASE_URL}/api/students?search=zzzzzzzz`, { headers: cookie(teacherToken) }),
    ]);
    expect([plain.status, withheld.status, garbage.status]).toEqual([200, 200, 200]);
    const [a, b, c] = await Promise.all([plain.json(), withheld.json(), garbage.json()]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.data.students).toHaveLength(25);
  });
```

Also assert the shape shrank, the issue's third criterion:

```ts
  it('carries no pagination envelope', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, { headers: cookie(teacherToken) });
    const json = await res.json();
    expect(json.data).not.toHaveProperty('total');
    expect(json.data).not.toHaveProperty('page');
    expect(json.data).not.toHaveProperty('pageSize');
  });
```

Run `npx vitest run --project integration tests/integration/students-api.test.ts`
**from a checkout with `:3000` live** (not this worktree — see Global
Constraints; if working here, this step's RED/GREEN is CI's to report). Expect
RED: the search parameter still filters, so `b` has one student and `a` has 25.

- [ ] **Step 2: Make it pass**

In `src/app/api/students/route.ts`, the `GET` handler becomes:

```ts
export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  // Unpaginated and unsearchable, both deliberately (#176). A `where` that
  // filtered on `firstName`/`lastName`/`email` answered questions about columns
  // `projectStudentForTeacher` redacts: a teacher denied a surname could
  // binary-search it from hit/miss and `total`. Searching and paging happen in
  // `student-directory.tsx`, over this response's own `displayName` and
  // `email` — so the searchable bytes are exactly the rendered ones, with no
  // server-side predicate that has to keep mirroring the projection.
  const archived = request.nextUrl.searchParams.get('archived') === 'true';

  const where = {
    teacherStudents: { some: { teacherId: session.teacherId, isArchived: archived } },
  };

  const students = await prisma.student.findMany({
    where,
    orderBy: { firstName: 'asc' },
    select: {
      ...studentVisibilitySelect(session.teacherId),
      registrations: {
        where: { class: { calendarEntry: { teacherId: session.teacherId } } },
        orderBy: { registeredAt: 'desc' },
        take: 1,
        select: { class: { select: { calendarEntry: { select: { date: true } } } } },
      },
      _count: {
        select: {
          registrations: {
            where: { class: { calendarEntry: { teacherId: session.teacherId } } },
          },
        },
      },
    },
  });
```

The rest of the handler (the `overdueGroups` groupBy, the `result` map) is
unchanged; the final line becomes `return respondOk({ students: result });`.

Deletions in the same file: the `Object.fromEntries(request.nextUrl.searchParams)`
line, the `studentListQuerySchema.safeParse` call and its 400 branch, the
`const { search, page, pageSize } = parsed.data;` destructure, the
`prisma.student.count({ where })` call and the `Promise.all` wrapping it, and
`studentListQuerySchema` from the import on `:4` (leave `createInvitationSchema`).

Then delete `studentListQuerySchema` from `src/lib/schemas.ts:288-292`.

- [ ] **Step 3: Rewrite the affected integration tests**

In `tests/integration/students-api.test.ts`:

- `returns paginated students for the teacher` → rename to `returns every student
  linked to the teacher`; drop the `?page=1&pageSize=10` params, assert
  `toHaveLength(25)`, delete the `total`/`page`/`pageSize` assertions.
- `returns page 3 with remaining students` → delete.
- `filters by search term (name)` and `filters by search term (email)` → delete.
- `does not return students not linked to the teacher` → **keep**. Drop
  `?search=Unlinked` and assert no returned `displayName` starts with `Unlinked`.
  Its subject is teacher scoping; it is stronger over the full list.
- `:728` (`the list withholds a surname and an email the student did not share`)
  → drop the `?page=1&pageSize=20` params. Its `.find()` already works unchanged.
- `fetchSingleStudent(search)` at `:856` → fetch the full list once and `.find()`
  a row whose `displayName` starts with the argument. Its three callers are
  unchanged. Keep the `toHaveLength(1)`-equivalent strictness by asserting the
  row was found.
- `maps counts to the right rows across a full page` at `:881` → drop the params
  and rename (there is no "page" any more); the `Map` it builds is unaffected.
- **The comment at `:721-727`** → rewrite. It names two tests as the #167
  mutation check; one is being deleted. State what is true now: which assertion
  currently exercises gating on the list route, without a roster of test titles
  that the next deletion will falsify again.

- [ ] **Step 4: Fix the comment in `api/invitations/route.ts`**

`:20-24` currently reads "No pagination, unlike GET /api/students… copy
`studentListQuerySchema`." Replace it (do not annotate it with what it used to
say). Both routes now return an unpaginated list, so the contrast is gone; if a
note is still worth keeping, it is about *this* route's working-set reasoning
alone, with no claim about the students route and no reference to a deleted
symbol.

- [ ] **Step 5: Prove the tether bites**

Reinstate the deleted `OR` clause in `where` (search only, no pagination), re-run
the two new tests, record the exact failure text, then restore. A tether that
cannot fail certifies nothing. Expect the `ignores a search parameter` test to
fail on `expect(b).toEqual(a)` with 1 student vs 25.

- [ ] **Step 6: Verify**

`npx tsc --noEmit` and `npm run lint` must be clean. `grep -rn
"studentListQuerySchema" src tests docs` must return **zero** hits.

---

### Task 2: Search and paginate in the directory

**Files:**
- Modify: `src/components/students/student-directory.tsx`
- Test: `src/components/students/student-directory.test.tsx`

**Interfaces:**
- Consumes: Task 1's `{ students }` response shape.
- Produces: nothing another task imports.

- [ ] **Step 1: Write the failing tests**

Add to `student-directory.test.tsx`, alongside the two existing rendering tests.
First update `stubStudents` to the new shape — `data: { students }`, no `total`,
`page` or `pageSize`.

Cover, at minimum:
- typing a first-name fragment narrows the list;
- typing a **shared** surname fragment finds the student (fixture: a row whose
  `displayName` is `'Anna Bakker'`);
- typing a **withheld** surname finds nothing (fixture: `'Bram k.'` — searching
  `kramer` must not match, which is the privacy property, and it holds because
  the withheld surname is not in the response at all);
- `"anna b"` matches `'Anna Bakker'` — the composed-name case no server-side
  option could deliver, and the reason this decision beats Option A/B;
- an email fragment matches a row whose `email` is non-null, and a row whose
  `email` is `null` never matches any query;
- with more than `PAGE_SIZE` rows the pager renders, and filtering to fewer than
  `PAGE_SIZE` hides it (`Pagination` returns `null` at `totalPages <= 1`).

Run `npx vitest run --project components src/components/students/student-directory.test.tsx`.
Expect RED.

- [ ] **Step 2: Make it pass**

In `student-directory.tsx`:

- `StudentListResponse` becomes `{ data: { students: StudentRow[] } }`.
- Delete the `total` state and the `debounceRef`; `fetchStudents` takes no
  arguments and its `useCallback` depends only on `[archived]`; the `useEffect`
  depends only on `[fetchStudents]`. The request URL carries `archived` when set
  and nothing else.
- The search input becomes controlled: `value={search}`, and
  `onChange={(e) => { setSearch(e.target.value); setPage(1); }}`. The 300 ms
  debounce goes — it was hiding a network round-trip, and the filter is now
  local. Resetting `page` on every keystroke is what stops a narrowed result set
  from stranding the viewer on a page that no longer exists.
- Derive, don't store:
  ```ts
  const query = search.trim().toLowerCase();
  const filtered = query
    ? students.filter(
        (s) =>
          s.displayName.toLowerCase().includes(query) ||
          (s.email?.toLowerCase().includes(query) ?? false),
      )
    : students;
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  ```
  `s.email` is `null` exactly when the student withheld it — that is
  `projectStudentForTeacher`'s contract, and it is what makes this filter
  privacy-safe without consulting a flag. Write that as the comment on the
  filter; it annotates the line it sits on.
- Render `visible`; the empty state branches on `filtered.length === 0`.

- [ ] **Step 3: Verify**

`npx vitest run --project components`, `npx tsc --noEmit`, `npm run lint`.

---

### Task 3: Give the walk-in picker the full roster and a local filter

**Files:**
- Modify: `src/components/class/add-walk-in.tsx`
- Create: `src/components/class/add-walk-in.test.tsx` — none exists; the component
  gains real logic here and needs coverage
- Modify: `src/lib/api-utils.test.ts` — the URL on `:474` only

**Interfaces:**
- Consumes: Task 1's `{ students }` response shape.

#### The reachability defect this removes

`add-walk-in.tsx:38` requests `?page=1&pageSize=50`, and above 50 students it
appends *"Showing your first 50 students — find the rest under Students."* That
sentence names a page with no walk-in control. Verified on this branch: exactly
two components create a registration — `BookingFlow`, mounted only at
`/(public)/[slug]/book/[classId]` (the student booking themselves), and
`AddWalkIn`, mounted only at `/(teacher)/class/[id]`. `/students/[id]` renders a
payment list, an archive button and a registration *history*, and offers no way
to add anyone to a class:

```sh
grep -rn "api/registrations'" src --include="*.tsx" | grep -v "\.test\."
grep -rn "BookingFlow\|AddWalkIn" src/app --include="*.tsx"
```

So a teacher with 51+ students **cannot add their 51st student to a class at
all** — the picker is the only path, it shows the first 50 by `firstName asc`,
and the escape hatch it offers goes nowhere. The cap exists only because the
endpoint paginates; deleting the pagination deletes the wall. This is a live
reachability defect fixed as a side effect, and belongs in the PR body as such.

- [ ] **Step 1: Write the failing tests**

Create `src/components/class/add-walk-in.test.tsx`, following the mocking idiom in
`student-directory.test.tsx` (shared `fetchMock`, stubbed per test, reset in
`afterEach`). Cover:
- the picker lists every student the response carries, with no truncation notice
  and no `pageSize` in the request URL;
- typing in the filter narrows the options;
- a student already registered stays excluded from the options *after* filtering
  (the existing `registeredStudentIds` behaviour must survive);
- **filtering away the current selection clears it** — see Step 2;
- when the filter matches nothing, the caption's "Add them under Students first"
  is what the teacher is left with.

- [ ] **Step 2: Update the picker**

- Drop `?page=1&pageSize=50` from the fetch, and delete `rosterTotal`,
  `setRosterTotal`, the `PAGE_SIZE` constant and the truncation clause.
- Keep *"Not in your students yet? Add them under Students first."* — with the
  roster complete, "not in the list" now genuinely means "not a student yet", so
  this sentence is accurate for the first time.
- Add an `Input` above the `Select`, filtering options on `displayName`:
  ```ts
  const query = filter.trim().toLowerCase();
  const visible = query
    ? students.filter((s) => s.displayName.toLowerCase().includes(query))
    : students;
  ```
- **Clear `selected` whenever the filter changes.** Without this, a teacher can
  narrow the list until the chosen student is no longer visible and still submit
  them — adding someone the UI is no longer showing. Do it in the filter's own
  `onChange`, not in an effect, so the cause is visible at the call site.
- When `visible` is empty, render a short `type-caption` line ("No student
  matches.") rather than an empty `<select>`, which renders as a bare box.

Three judgement calls, recorded so a reviewer need not re-derive them:
`displayName` only and not `email` (the picker's `RosterStudent` declares just
`id` and `displayName`, and a teacher adding a walk-in is looking at the person);
the filter input is always visible rather than appearing above a threshold (no
arbitrary constant to defend); and the native `<select>` is kept with its options
filtered rather than rewritten as a combobox (minimal change to a working
control — a combobox is not what #176 asks for).

- [ ] **Step 2: Update the log-redaction test's URL**

`src/lib/api-utils.test.ts:474` builds
`http://localhost/api/students?search=alice&token=sensitive`. The test asserts
the query string is not logged; `search=alice` is incidental decoration, but it
would cite a parameter that no longer exists. Change it to a parameter the route
still takes (`?archived=true&token=sensitive`). Do not weaken the assertion —
`token=sensitive` is the part under test.

- [ ] **Step 3: Verify**

`npx vitest run --project components --project unit`, `npx tsc --noEmit`,
`npm run lint`.

---

## Verification for the whole branch

- `npx tsc --noEmit` clean.
- `npm run lint` clean.
- `npx vitest run --project unit --project components` green, with the count
  stated as arithmetic in the PR body.
- **`integration` and `e2e` are CI's to report from this worktree** — neither can
  run here (no `:3000`, no shared dev DB). Cite the CI run in the PR body for
  that tier, not a local `verify`.
- `grep -rn "studentListQuerySchema" src tests docs` returns zero hits.
- Manually confirm the three acceptance behaviours in the running app if a
  checkout with `:3000` is available: first-name search narrows; a shared
  surname finds; `"anna b"` matches a full name.
