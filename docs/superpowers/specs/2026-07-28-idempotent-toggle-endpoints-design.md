# Toggle endpoints name their target state

**Date:** 2026-07-28
**Status:** Approved (issue #98; scope widened to six endpoints and the #99
pairing settled with Ivo in discussion)

## Problem

Six `PATCH` endpoints compute the new state server-side as the negation of the
current one, so the request carries no intention:

| Route | Today |
|---|---|
| `class-templates/[id]` | `data: { isActive: !template.isActive }` |
| `class-templates/[id]?action=archive` | `archiving = !template.isArchived` |
| `studio-class-templates/[id]` | same two, studio family |
| `teacher-rooms/[id]` | `data: { isArchived: !teacherRoom.isArchived }` |
| `students/[id]` | `data: { isArchived: !link.isArchived }` |

Issue #98 named four; enumerating the callers found six. `archive-room-button`
and `archive-student-button` have the identical shape and were missed because
they live outside `settings/` and the issue was written from the #93 diff.

Two failure modes follow from the missing intention.

**A retry inverts the action.** The teacher clicks Archive. The server commits.
The response is lost or truncated — or `await res.json()` throws, which sits
inside the same `try` as the `fetch`. The button reports *"Network error. Please
try again."*, `router.refresh()` never ran so the label still reads "Archive",
and the natural second click **un-archives**.

**A stale tab does the opposite of its own label.** `isArchived` is a prop
captured at the last render. Archive in tab A, then click the still-stale
"Archive" button in tab B, and the server un-archives — while the client, which
branches on its own stale prop, captions it with the archive confirmation.

The consequence is worst on the template families, where #93 made *"archived
means not bookable"* load-bearing: an accidental un-archive is a shelved class
back on the public booking page. On rooms and students the damage is cosmetic,
but the fix is two lines each and splitting the families is how they drift —
which is what PR #92 found the last time a fix stopped at the obvious half.

## Design

### 1. The request names its target; the server sets it absolutely

A single query parameter replaces the current `?action=archive` branch, because
the target value already identifies the field:

| Route | Accepted values |
|---|---|
| `class-templates/[id]`, `studio-class-templates/[id]` | `active`, `paused`, `archived`, `unarchived` |
| `teacher-rooms/[id]`, `students/[id]` | `archived`, `unarchived` |

The parameter is **`state`**, not `to`. `to` is already a date-range bound on
`GET /api/classes` (`src/app/api/classes/route.ts:19`); reusing the name for an
unrelated meaning in the same API is the kind of thing that reads fine today and
misleads later.

Validation follows the existing convention — `Object.fromEntries(searchParams)`
into a zod schema, as `GET /api/rooms` does with `roomSearchQuerySchema`
(`src/app/api/rooms/route.ts:17-21`). Two schemas, since the accepted sets
differ:

```ts
export const templateStateQuerySchema = z.object({
  state: z.enum(['active', 'paused', 'archived', 'unarchived']),
});

export const archiveStateQuerySchema = z.object({
  state: z.enum(['archived', 'unarchived']),
});
```

**A missing or unrecognised `state` is a 400**, never a fallback to toggling.
A fallback would leave the old behaviour reachable for any caller that forgets
the parameter, which is exactly how one defect came to exist in six places.

### 2. Already in the target state is a success

The endpoint returns 200 with `action: 'unchanged'` and performs no write and no
side effects. This is not an edge case bolted on — it is the state both failure
modes actually reach: the stale tab, and the retry whose first attempt committed.

It also fixes a live hazard on the archive path specifically. Today a second
archive click un-archives, which un-shelves the template. Under this design it
is a no-op, and in particular **does not re-run the withdrawal** — the deletion
of unbooked future classes stays a one-time consequence of the transition, not
of the request.

Templates archived before #93 shipped keep their standing windows; this design
does not backfill them, and that remains a separate question.

### 3. Result types gain one member

`ArchiveTemplateResult` already discriminates on `action` (#93). It gains a third
success arm, and the pause/resume result gains the discriminant it never had:

```ts
export type PauseTemplateResult =
  | { ok: true; action: 'paused'; template: ClassTemplate;
      lastScheduled: { date: Date; startTime: string } | null }
  | { ok: true; action: 'active'; template: ClassTemplate }
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' };

export type ArchiveTemplateResult =
  | { ok: true; action: 'archived'; template: ClassTemplate; deleted: number; remaining: number }
  | { ok: true; action: 'unarchived'; template: ClassTemplate }
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' | 'forbidden' };
```

`lastScheduled` moves onto the `paused` arm only — resuming and no-opping have
nothing to report, and the current type makes a caller believe otherwise. The
routes' existing `const unhandled: never` checks then force every call site to
answer for `unchanged` rather than fall through to the wrong branch.

The two non-template routes return `{ isArchived, action }` rather than a
service result; they have no service layer today and this change does not add
one.

### 4. Existing guards are unchanged

`?state=active` on an archived template still returns **409** *"Unarchive the
template before activating it"* (`class-templates/[id]/route.ts:139`, studio
equivalent at `:109`). Naming the target does not make that transition legal;
it only makes the request unambiguous about having asked for it.

Ownership checks, the 404s, and the 403s all stand as they are.

### 5. What this removes from the problem

With idempotent requests, `"Network error. Please try again."` stops being a trap
and becomes correct advice: the retry is safe whether or not the first attempt
committed. So the client-side error-handling rework #98 describes as the other
half of the fix is **not needed**, and is deliberately not in this spec.

One client change does carry its weight. Each button needs to decide, from the
server's answer, whether to show a confirmation and which one — and `unchanged`
must show neither the pause nor the archive message, since both would describe
something that did not happen. That decision becomes a pure function:

```ts
/** null means "say nothing" — the correct answer for unarchived and unchanged. */
export function resolveConfirmation(
  data: { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
      | { action: 'archived'; deleted: number; remaining: number }
      | { action: 'active' | 'unarchived' | 'unchanged' },
): string | null;
```

One per family, since the archive wording differs between classes and studio
classes; the exact split is the plan's to settle. Tested in the existing node
project. This is the seam the wrong-shape bug in #93
lived inside (`archiveStudioMessage` had the wrong signature and the button
silently discarded `remaining`; caught by review, not by tests), so it is the
part of the client worth pinning.

**The target derivation stays inline** at each button, immediately beside the
label ternary that reads the same prop. Extracting one and not the other is how
a button comes to send `archived` while captioning itself "Unarchive".

## Testing

**Integration**, per route — this is where the behaviour lives:

- each accepted `state` value reaches the intended state from both starting
  points;
- the same request twice is idempotent: second call returns `action: 'unchanged'`
  and the row is untouched;
- **archiving twice does not withdraw twice** — the classes surviving the first
  archive are still there after the second;
- missing `state` → 400; unrecognised `state` → 400;
- `?state=active` on an archived template still → 409;
- ownership and not-found guards still → 403 / 404.

**Unit**, for the one pure function: `resolveConfirmation` returns the pause
message for `paused`, the archive message for `archived`, and **null** for both
`unarchived` and `unchanged`.

**Mutation-verified**, and per the #66 lesson each mutation is confirmed to have
applied inside the function under test before its result is trusted. The
load-bearing mutation is restoring the negation in one route: the idempotency
test must fail. A fix whose tests pass against the old toggling behaviour has
not been tested.

## Out of scope

- **#99's jsdom/testing-library layer.** Settled in discussion: a build-config
  change and two dev dependencies do not belong inside a correctness fix. The
  pure function above is #99's own cheap option, taken here; the render paths it
  cannot reach stay #99's.
- **The `errorMessage` copy and the catch-block structure.** Made correct by
  idempotency rather than by editing, per §5.
- **Backfilling templates archived before #93.** Separate, already noted.
- **Adding a service layer to `teacher-rooms` / `students`.** They have none; this
  change does not introduce one for two-line handlers.

## Risks

- **Six routes change shape at once.** Every caller is in this repo — six buttons
  and roughly 17 integration call sites — and a missing `state` now fails loudly
  with a 400 rather than silently toggling, so a missed caller surfaces on the
  first run rather than in production.
- **`?action=archive` disappears.** Nothing outside this repo consumes it; there
  is no public API and no released client.
- **`unchanged` could mask a genuine failure** if a route returned it when it
  should have acted. The integration tests assert the row's state after the call,
  not just the discriminant, so a route that no-ops when it should write fails
  on the state assertion.
