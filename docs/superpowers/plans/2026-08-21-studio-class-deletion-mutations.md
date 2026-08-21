# Mutations — studio class deletion (issue 279)

Each guard below was broken, the exact failure text was captured from a real
run, the mutation was restored, and green was re-verified before moving on.
M1–M5 were scored against `src/services/studio-class-deletion.test.ts`
(`npx vitest run --project unit src/services/studio-class-deletion.test.ts`);
M6–M7 are scored against the integration suite and are appended under Task 2.

## Task 1 — the predicate

### M1 — day granularity instead of start instants

Mutation: replaced the second clause with
`startOfLocalDay(sc.date, timeZone) <= startOfLocalDay(now, timeZone)`
(and swapped the import to `startOfLocalDay`).

Result: **RED**, exactly where predicted.

```
 ❯ |unit| src/services/studio-class-deletion.test.ts (7 tests | 1 failed) 23ms
       × west of UTC: a 09:00 New York class has not started by 12:00 UTC 5ms
 FAIL  |unit| src/services/studio-class-deletion.test.ts > studioClassDeletability > the zone decides, not UTC > west of UTC: a 09:00 New York class has not started by 12:00 UTC
AssertionError: expected { deletable: true } to deeply equal { deletable: false, …(1) }
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

Restored → 7 passed.

### M2 — drop the manual disjunct

Mutation: deleted the `if (sc.templateId === null) return { deletable: true };` line.

Result: **RED** on the predicted case.

```
 ❯ |unit| src/services/studio-class-deletion.test.ts (7 tests | 1 failed) 24ms
       × allows a manual class that has not started 20ms
 FAIL  |unit| src/services/studio-class-deletion.test.ts > studioClassDeletability > the matrix > allows a manual class that has not started
AssertionError: expected { deletable: false, …(1) } to deeply equal { deletable: true }
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

Restored → 7 passed.

### M3 — drop the past-instant disjunct

Mutation: deleted the `classStartInstant(...) <= now` line.

Result: **RED** on three cases — every "generated class that has started"
variant. The plan named "both has-started cases"; the run also reddened the
boundary case, which is the same predicate clause and is covered by M5's own
pin, so the count is 3 rather than 2:

```
 ❯ |unit| src/services/studio-class-deletion.test.ts (7 tests | 3 failed) 10ms
       × allows a generated class that has started, because it is no longer a candidate 5ms
       × east of UTC: a 09:00 Amsterdam class has started by 08:00 UTC 2ms
     × treats the start instant itself as started 1ms
 Test Files  1 failed (1)
      Tests  3 failed | 4 passed (7)
```

(The two matrix "manual" cases still pass under M3 because they short-circuit on
`templateId === null`; the zone case that fails is the east-of-UTC one, which is
a *generated past* case.)

Restored → 7 passed.

### M4 — widen the parameter to carry template state

Mutation: widened the first parameter to
`{ templateId; date; startTime; template: { isArchived: boolean } }`, added
`if (sc.template.isArchived) return { deletable: true };`.

Gate: `npm run typecheck` — not vitest. **The failure is a compile error, which
is the point**: §4.2's wrong edit is supposed to be unrepresentable, so its
proof is `tsc` refusing to compile any call site that does not supply template
state. This is stronger than a red test — a red test can be deleted or
skipped; this signature cannot be satisfied without threading reversible state
through every caller.

Result: **RED** — recorded at the time as "7 errors, one per call site". That
was an **undercount, and the reason is a trap worth more than the number**: 7 is
the test file's call sites only. The real figure is **9 errors across 3 files** —
the 7 tests plus `route.ts` and `page.tsx` — reproduced under review. `tsconfig`
sets `"incremental": true`, so a warm `tsconfig.tsbuildinfo` suppresses errors in
files the mutation did not itself touch. **Score any typecheck-gated mutation
with `tsc --noEmit --incremental false`**, or a surviving mutant can read as
caught. The original transcript follows unedited:

```
src/services/studio-class-deletion.test.ts(18,11): error TS2345: Argument of type '{ templateId: null; date: Date; startTime: string; }' is not assignable to parameter of type '{ templateId: string | null; date: Date; startTime: string; template: { isArchived: boolean; }; }'.
  Property 'template' is missing in type '{ templateId: null; date: Date; startTime: string; }' but required in type '{ templateId: string | null; date: Date; startTime: string; template: { isArchived: boolean; }; }'.
src/services/studio-class-deletion.test.ts(28,11): error TS2345: ...
src/services/studio-class-deletion.test.ts(38,11): error TS2345: ...
src/services/studio-class-deletion.test.ts(48,11): error TS2345: ...
src/services/studio-class-deletion.test.ts(67,11): error TS2345: ...
src/services/studio-class-deletion.test.ts(78,11): error TS2345: ...
src/services/studio-class-deletion.test.ts(90,9): error TS2345: ...
```

(lines 28/38/48/67/78/90 carry the identical TS2345 text as line 18)

Restored → 7 passed and `tsc --noEmit` clean.

### M5 — strict `<` instead of `<=`

Mutation: changed the boundary comparison from `<=` to `<`.

Result: **RED** on the boundary case only.

```
 ❯ |unit| src/services/studio-class-deletion.test.ts (7 tests | 1 failed) 19ms
     × treats the start instant itself as started 4ms
 FAIL  |unit| src/services/studio-class-deletion.test.ts > studioClassDeletability > treats the start instant itself as started
AssertionError: expected { deletable: false, …(1) } to deeply equal { deletable: true }
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

Restored → 7 passed.

## Task 2 — the route

All integration mutations were scored after warming the route with
`curl -X DELETE http://localhost:3000/api/studio-classes/warm` (→ 401), per the
lazy-recompile hazard.

### M6 — remove the route's ownership check

Mutation: deleted `if (studioClass.teacherId !== session.teacherId) return respondError('Access denied', 403);` from the `DELETE` handler.

Result: **RED** on exactly the cross-teacher case; every other gate still
passes in front of it, which is why this mutation is listed at all.

```
 FAIL  |integration| tests/integration/studio-api.test.ts > DELETE /api/studio-classes/[id] > refuses another teacher's class with 403
AssertionError: expected 200 to be 403 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 46 passed (47)
```

Restored → 47 passed.

### M7 — skip the predicate, delete unconditionally

Mutation: removed the `studioClassDeletability(...)` call and its refusal block,
leaving the handler to delete unconditionally after the ownership check.

Result: **RED** on exactly the two predicted cases, both reading
`expected 200 to be 409`:

```
     × refuses a future generated class, naming cancel and the code 36ms
     × still refuses a future generated class when its template is archived 39ms
 Test Files  1 failed (1)
      Tests  2 failed | 45 passed (47)
AssertionError: expected 200 to be 409 // Object.is equality   (× both)
```

Restored → 47 passed.

## Plan defects found while building

- **Task 2's success-shape assertion was wrong.** The plan's test for "removes
  a future manual class" asserted `await res.json()).toEqual({ deleted: true })`.
  `respondOk` wraps payloads in a `data` key (`src/lib/api-utils.ts:9-11`, same
  as every other route in the app, including `rooms/[id]/route.ts:114` that the
  plan itself cites). The assertion was corrected to `{ data: { deleted: true } }`;
  the route code is unchanged and matches the spec. First observed as
  `expected { data: { deleted: true } } to deeply equal { deleted: true }`.

- **Task 4's earnings case asserted on text no server render can contain.**
  The plan's case 4 expected the served HTML to contain
  `45.00 will come off your reported earnings`, but that sentence lives in the
  client component's confirm state (`confirming === false` initially), so it
  renders only after a click — unpassable by the plan's own component design,
  which keeps the two-step confirm. The assertions now read what a fetch can
  actually observe: the serialized props handed across the server/client
  boundary (`\"earningsAtRisk\":45` present for the in-window class;
  `\"earningsAtRisk\":null` present and no number threaded for the out-of-window
  one), plus the pre-click absence of the sentence itself. This still pins the
  D3 rule end to end: a page that derived the claim from `deletable` would
  thread a number into both documents.

- **The Step-2 RED prediction ("every case") was off by two**, and both passes
  are explained by the task ordering the plan itself mandates: "offers no
  removal on a future generated class" passes trivially against a page that
  renders no Remove action anywhere yet, and the reporting end-to-end case
  passes because Task 2's route already existed when Task 4 ran. Three cases
  failed, which is the meaningful part: exactly the three that require the page
  change.

## Task 4 Step 5 — the running-app check, and what it actually found

Driven with a throwaway tsx + Playwright script against the dev server already
on :3000 (`reuseExistingServer: true`; nothing was started or restarted).
Fixtures via Prisma; session seeded with the suite's own helper.

**Verdicts:**

1. **Stale-false direction confirmed.** A *generated* class dated today,
   startTime 23:59 Amsterdam (start ahead all day), renders **no** Remove
   action. The first probe run reported the opposite — that was fixture error,
   not app error: the class was manual, and a manual class is removable at any
   hour by design (§2's first disjunct). The "after" half of the flip is
   integration case 4 (today at local midnight → action present).
2. **The schedule DID list a just-removed class after landing — transiently.**
   With the plan's original `router.push('/')`, the landed schedule rendered
   the removed row, then revalidated itself shortly after (Next 16 refetches
   dynamic payloads post-navigation) — the visible list self-healed within the
   settle window, while the stale flight data stayed embedded in the document.
   On a slow mobile connection that flash reads as "the removal failed", the
   exact confirm-then-silence family the cancel button's comments document.
3. **`router.refresh()` beside the push does NOT reliably fix it.** Both
   orderings were tried; refresh revalidates whichever route is current when
   it fires — the one being left, or a race with the in-flight navigation.
   The shipped fix is `window.location.assign('/')`: a full navigation cannot
   serve a pre-removal payload. Verified clean (row absent, no residue in the
   final DOM). Trade-off recorded in the component's docblock: SPA smoothness
   is traded for a landing that is correct by construction.
4. **DeleteRoomButton observation (not this branch's defect):** it exits with
   a bare `router.push('/settings/rooms')` and inherits the same transient
   staleness on Next 16. Left untouched — different surface — flagged here for
   the owner.

**Probe-methodology lessons, recorded because they cost two false verdicts:**

- Schedule cards render `classType · location` for studio entries
  (`class-list.tsx:140`). The first probe gave its live control fixture the
  same marker string as the removed row, so three consecutive STALE readings
  were detecting the *control*, not the removal. Key probes on a string only
  the subject can render.
- ~~`startOfLocalDay(now, tz)` is an instant; stored into `@db.Date` it
  truncates to the UTC date-part — *yesterday* for east-of-UTC zones at most
  hours.~~ **WITHDRAWN — this was wrong, and it propagated.** `startOfLocalDay`
  does not return an instant. It formats the instant in the teacher's zone and
  returns `Date.UTC(localY, localM, localD)` (`src/lib/timezone.ts:81-95`) — the
  teacher's local calendar date, already in the midnight-UTC representation
  `@db.Date` stores. Measured across the east-of-UTC edge: at 2026-08-21T22:30Z
  it returns 2026-08-22 for a Europe/Amsterdam teacher, which is that teacher's
  today, not yesterday. The function's own docblock states the contract, and it
  exists *because* the naive comparison is wrong. So the plan's Task 4 case-4
  fixture stores today's date correctly and its "dated today" narrative is
  accurate. The claim reached PR #295's body before anyone read the helper.

---

## M8 — the boundary of the corrected rule (added during PR review)

PR #295's review found that the shipped predicate asked the wrong question: it
compared the CLASS's start instant against now, while the generator filters
candidates on the TEMPLATE's current `startTime`. After a template time edit the
two disagree by design ("a template is a stamp, not a live link"), so a class
that had started could still be a generator candidate that same day — removal
released `(templateId, date)` and the sweep re-inserted within the hour.

The rule is now a calendar-date comparison. This mutation restores the old
permissiveness at its boundary.

Mutation: `startOfLocalDay(now, timeZone) > sc.date` → `>=`, i.e. a generated
class dated TODAY becomes removable again.

Result: **RED at both layers.**

```
 ❯ |unit| src/services/studio-class-deletion.test.ts (11 tests | 3 failed)
       × refuses one whose own start passed hours ago
       × refuses one at the last minute of the teacher’s day
       × west of UTC: still the 14th in New York, so the 14th is refused though UTC calls it yesterday
      Tests  3 failed | 8 passed (11)
```

```
 ❯ |integration| tests/integration/studio-api.test.ts (50 tests | 1 failed)
       × refuses a generated class dated today, however long ago it started
AssertionError: expected 200 to be 409 // Object.is equality
      Tests  1 failed | 49 passed (50)
```

The west-of-UTC case reddening is the useful part: it means the mutation is
caught on the *zone* axis too, not only on the boundary — a teacher at 22:30 on
the 14th in New York must not be able to remove the 14th, and `>=` lets them.

Restored → 11 passed, 50 passed.

**Not scored, and named so the gap is visible:** the optional-widening edit
(`template?: { isArchived: boolean }`) is a mutation that **survives** — `tsc`
clean, lint clean, whole suite green. It is documented in
`studio-class-deletion.ts`'s docblock rather than hidden, and the
`@ts-expect-error` case in the test file is the one site that now catches it.

