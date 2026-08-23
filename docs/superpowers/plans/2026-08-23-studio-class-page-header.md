# The studio class page titles itself by location — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The studio class detail page heads with the class's type (falling back to
location only when type is empty), a Location row keeps the venue on the page in both the
live and cancelled states, and both facts are pinned by tests that can fail.

**Architecture:** One-line title change plus one details row in
`src/app/(teacher)/studio-class/[id]/page.tsx`; no service, API, schema or migration work.
Coverage lands in the existing integration file and the existing e2e arc.

**Tech Stack:** Next.js App Router server components, TypeScript strict, Vitest (3 projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-studio-class-page-header-design.md` — read §1
(the corrections) and §4 (guard-biting steps) before starting.

**Branch:** `fix/304-studio-class-page-header` (create from current `main` before Task 1).

---

## Global Constraints

- **Never start or restart the dev server on :3000** — it is running; the integration project and e2e need it.
- **Warm routes before judging red/green.** After any source edit, `curl` the touched route once before trusting a test result (`next dev` compiles lazily; a cold-route timeout reads like an assertion failure).
- **Quote paths containing parentheses**: `"src/app/(teacher)/studio-class/[id]/page.tsx"`.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Never write `close/closes/fixes/resolves #304` in any commit message.** Write "**leaves #304 open until merge**" or nothing. The PR body references are the orchestrator's job.
- **Commit per task**; the PR is rebase-merged.
- TypeScript strict, no `any`. Prettier/ESLint run in `npm run verify`.

---

## Baseline (measured 2026-08-23)

- Dev server :3000 answering (HTTP 307 from `/`). DB container `fairyoga-db-1` healthy.
- `npx vitest run --project integration tests/integration/studio-class-page.test.ts`
  → **6 passed**. After Task 1: **8** (two new assertions live inside two *existing* cases,
  so the count moves only if a case splits — predict 8 only if the venue-row anchor goes in
  its own case; as planned it does not, so predict **6 still**, with two assertions added).
  Measure, don't trust the prediction.
- No visual baselines cover `/studio-class/[id]` (`visual.spec.ts` snapshots the template
  detail page only) — nothing to regenerate.

---

## File structure

| File | Change |
|---|---|
| `src/app/(teacher)/studio-class/[id]/page.tsx` | Header title becomes `classType \|\| location`; Location row inserted between Time and Hourly rate |
| `tests/integration/studio-class-page.test.ts` | Heading assertion in case 1; `>Location</span>` anchor beside both venue assertions; heading + Location row pinned on the cancelled case, which nothing else covers |
| `tests/e2e/studio.spec.ts` | Heading assert in generated-class arc; heading + venue-row assert in manual-log arc |

Nothing else. If an implementer finds itself touching anything else, stop and report.

---

### Task 1: Integration tests first (red), then the fix (green), then prove both guards bite

**Files:**
- Modify: `tests/integration/studio-class-page.test.ts`
- Modify: `"src/app/(teacher)/studio-class/[id]/page.tsx"`

**Steps:**

- [ ] 1.1 In the first case ("offers no removal on a future generated class", ~:97-102),
      add after the existing `Community Studio` assertion:
      `expect(html).toContain('Page Case</h1>');`
      Anchored to the closing tag — 'Page Template' belongs to the Template link, so a bare
      `'Page Case'` would already be unambiguous, but the closing tag also survives anyone
      rewording other copy.
- [ ] 1.2 In BOTH cases asserting `toContain('Community Studio')` (~:100 and ~:131), add
      alongside each: `expect(html).toContain('>Location</span>');`
- [ ] 1.3 Run the file against unfixed source:
      `npx vitest run --project integration tests/integration/studio-class-page.test.ts`
      **Expected RED**: the three new assertions fail because the h1 reads
      'Community Studio' and no element carries 'Location'. Record the exact failure text
      in the task report.
- [ ] 1.4 Apply the fix in `"src/app/(teacher)/studio-class/[id]/page.tsx"`:
      - Line 71 → `<PageHeader title={studioClass.classType || studioClass.location} backHref="/" backLabel="Schedule" />`
      - Insert between the Time row and the Hourly rate row:
        ```tsx
        <div className="min-h-14 py-2 border-b border-border">
          <span className="type-label">Location</span>
          <p className="text-base text-ink">{studioClass.location}</p>
        </div>
        ```
      - Match sibling rows' indentation exactly. No comments unless mirroring a neighbour's.
- [ ] 1.5 Warm the route: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/studio-class/<some-id>` (any id; a 307/200/404 all prove compilation happened). Re-run the file → **GREEN, 6 passed**.
- [ ] 1.6 **Guard-biting proof, M1 (header revert):** temporarily restore line 71 to
      `title={studioClass.location}` → run file → the `Page Case</h1>` assertion must fail;
      record error text. Restore.
- [ ] 1.7 **Guard-biting proof, M2 (row deletion):** delete only the new Location block →
      run file → both `>Location</span>` assertions AND both `Community Studio` assertions
      must fail (the venue is genuinely gone from the page). Record. Restore, re-run green.
- [ ] 1.8 Commit: `test+fix: studio class page heads with its class type, location row keeps the venue visible (#304 groundwork)`
      Stage exactly: `tests/integration/studio-class-page.test.ts` and `"src/app/(teacher)/studio-class/[id]/page.tsx"`.

### Task 2: e2e pins the pairing at the door the teacher walks through

**Files:**
- Modify: `tests/e2e/studio.spec.ts`

The source fix landed in Task 1, so these asserts will be green immediately — their bite
is proven afterwards by mutation (step 2.5), which needs warm routes (constraint above).

**Steps:**

- [ ] 2.1 Generated-class arc ("generated classes appear four times…", ~:201-210): after
      the existing `Remove this class` count assertion on `/studio-class/${first.id}`, add:
      `await expect(page.getByRole('heading', { name: 'Studio Flow' })).toBeVisible();`
      This is the issue's exact scenario — card says Studio Flow · Community Studio, page
      must agree.
- [ ] 2.2 Manual-log arc ("log, count, cancel, remove"): immediately after the
      `expect(page.url())` assertion (~:491), add:
      `await expect(page.getByRole('heading', { name: 'Cover Class' })).toBeVisible();`
      and `await expect(page.getByText('Guest Studio')).toBeVisible();`
      Exercises the non-fallback branch end-to-end from the form the teacher filled.
- [ ] 2.3 Run the e2e suite scoped if possible, else the whole file:
      `npx playwright test tests/e2e/studio.spec.ts`
      Expected GREEN (fix landed in Task 1).
- [ ] 2.4 **Bite check without a false pass:** confirm these asserts could have failed by
      construction — they name strings ('Studio Flow', 'Cover Class', 'Guest Studio') the
      test itself created, and `getByRole('heading', …)` matches the `<h1>` PageHeader
      renders. Note in the report what each would see under the old header
      (location-only): 'Studio Flow' heading assert fails, 'Cover Class' fails,
      'Guest Studio' getByText still passes via the NEW row — which is why 2.1/2.2's
      heading half is the load-bearing one.
- [ ] 2.5 **Mutation proof, M3 (header revert again, e2e side):** apply M1's revert,
      curl `/` and one `/studio-class/[id]` to warm, then run the **whole file**:
      `npx playwright test tests/e2e/studio.spec.ts` → both heading asserts RED at their own
      lines (208 and 502), on both browser projects. Record text. Restore, warm, re-run GREEN.
      Do **not** scope this with `-g`. The template describe is serial and `templateId` is
      set by its first test, so any filter excluding that test makes the generated-class arc
      bail at `requireTemplateId()` long before the heading assertion — a run that reports
      failures while never executing the guard under test.
- [ ] 2.6 Commit: `test: e2e pins the studio class page heading to the class its card named (#304 groundwork)`
      Stage exactly: `tests/e2e/studio.spec.ts`.

### Task 3: Whole-suite gate and claim sweep

- [ ] 3.1 `npm run verify` — all three vitest projects + typecheck + lint. Record the
      three per-project files/tests counts and show them reconciling (files sum, tests sum)
      for the PR body.
- [ ] 3.2 Re-derive spec §6's claims:
      `grep -rn "classType || " src/ --include='*.tsx'` → **four** matching lines, because
      the three list sections render through one shared `StudioTemplateRow`: that row
      (`studio-template-list.tsx:46`), the template detail header, the Template link on this
      page, and this header. Four code sites, six surfaces. The card's ternary
      (`class-list.tsx:140`) is a different expression and matches nothing in this grep —
      check it separately. Then confirm no bare title survives:
      `grep -rnE 'title=\{[a-zA-Z.]+\.location\}' src/ --include='*.tsx'` → the only two
      hits are the `classType || location` headers themselves.
- [ ] 3.3 Confirm no doc claims went stale: grep `docs/` for "titles by location"-class
      phrases about the studio class page (the roadmap's #281/#304 entries describe the
      defect historically — those stay).
- [ ] 3.4 Commit anything the sweep corrected (expected: nothing), or report clean.

---

## Stop conditions

An implementer stops and reports rather than improvising when:

1. Any step's expected RED doesn't fail, or expected GREEN doesn't pass after warming —
   do not raise timeouts; report the output.
2. The fix requires touching any file outside the three listed.
3. The `Community Studio` assertions fail in a way M2 didn't predict (means something else
   was carrying the venue).

## Reporting back

Per task: files changed, exact failure text from each guard proof, test counts before/after,
commit hash. Final: the reconciled verify arithmetic for the PR body.
