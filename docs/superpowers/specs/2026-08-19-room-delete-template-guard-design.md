# Room deletion: the template blocker, and the lock cycle it was hiding

Issue 103. Two problems the issue presents as related; they turn out to be **one
guard apart**, which is the finding that shaped this design.

---

## 1. What the issue claimed, and what was measured

The issue was filed out of #95's final review, before #76, #113 and the
api-error-classification branch landed. Three of its claims have moved.

### Held: both foreign keys are `RESTRICT`

`prisma/migrations/20260403092044_init/migration.sql:339,345` — verified
verbatim, the issue's citation is exact:

```sql
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_teacherRoomId_fkey"
  FOREIGN KEY ("teacherRoomId") REFERENCES "TeacherRoom"("id") ON DELETE RESTRICT ...
ALTER TABLE "Class" ADD CONSTRAINT "Class_teacherRoomId_fkey"
  FOREIGN KEY ("teacherRoomId") REFERENCES "TeacherRoom"("id") ON DELETE RESTRICT ...
```

### Held, and is live: the 500

Reproduced against the running app on 2026-08-19, with a `TeacherRoom` carrying
**zero** `Class` rows and one **archived** `ClassTemplate`:

```
[REPRO teacher-rooms] status=500 body={"error":{"message":"Internal server error"}}
[REPRO rooms]         status=500 body={"error":{"message":"Internal server error"}}
```

Both routes, not one. `classifyApiError` (`src/lib/api-errors.ts:267`) has
branches for the terminality triggers, `isTransientDbError`, and `P2002`;
`P2003` matches none, so it falls to the generic 500 at `:350` — `level:
'error'`, the level that pages someone.

This is **user-visible, not API-only**. `src/components/settings/delete-room-button.tsx:22`
and `src/components/settings/unlink-room-button.tsx:23` are real buttons, and
both render `json.error?.message` verbatim into `text-danger`. The teacher reads
the words "Internal server error".

### Moved: the deadlock's consequence is already handled

The issue predicts `40P01` and treats that as the harm. Since it was filed,
`src/lib/api-errors.ts:174` shipped:

```ts
const TRANSIENT_SQLSTATES = ['40001', '40P01', '55P03'] as const;
```

routed at `:325` to **503**, *"The system was busy and could not finish that.
Please try again."*, at `level: 'warn'`. The generator's claim also now takes
`LOCK_TIMEOUT_SQL` before its `FOR UPDATE` (`src/services/class-generator.ts:319`),
which the issue predates.

So the cycle is real and its blast radius is a retryable 503 on whichever side
Postgres kills — for the sweep, one template skipped and logged, since
`generateClassInstances` isolates per template.

### New, and it reshapes the fix: a `ClassTemplate` is never hard-deleted

`src/app/api/class-templates/[id]/route.ts` exports `GET` (`:19`), `PUT`
(`:40`) and `PATCH` (`:141`) — **no `DELETE`**. `grep -rn "classTemplate.delete" src/`
returns nothing outside tests.

A room that has ever carried a recurring template is therefore **permanently**
undeletable, exactly like a room with class history. The issue asks for "a 409
with the same 'still in use' message the `Class` check produces", which implies
a blocker the teacher can clear. There is none.

### The two halves are one fix

The deadlock needs a `ClassTemplate` row to exist — that row is what makes the
`RESTRICT` trigger take `FOR KEY SHARE` on `ClassTemplate`, which is one edge of
the cycle. A guard that refuses the delete whenever *any* template references the
room means the `DELETE` statement is **never issued** in the deadlocking case.

Fixing the 500 closes the deadlock as a side effect. What remains of part 1 is a
check-to-delete TOCTOU, and its outcome is already the 503 above.

---

## 2. Design

### 2.1 The guard (both routes)

Alongside each existing `Class` check, count `ClassTemplate` rows for the same
`teacherRoomId` and refuse with **409** and the string the `Class` guard already
returns:

> `Cannot delete a room with class history. Archive it instead.`

**The predicate is every template — no `isActive` / `isArchived` filter.** This
deliberately differs from the archive door, which uses `ACTIVE_TEMPLATE_WHERE`
(`src/lib/template-selection.ts`), and the difference is the point: archiving
asks *"would a template put classes here?"*, which only a live template does. A
foreign key asks *"does a row point here?"*, and it does not read `isActive` or
`isArchived`. Sharing `ACTIVE_TEMPLATE_WHERE` here would leave the reproduced
500 exactly as it is, because the row that reproduced it is archived.

`rooms/[id]` counts across every `TeacherRoom` on the room, matching the shape
of its existing `hasClasses` check (`:37`).

**One message for both causes, deliberately.** A template is not literally class
history, and a teacher blocked only by an archived template may look for classes
that are not on their schedule. Accepted, because both causes are permanent and
share one remedy, so the confusion cannot produce a wrong action — the same
reasoning `classifyApiError:295-297` states for the terminality message
(*"Both triggers reach this branch and both mean the same thing to the caller —
so any wording that names one column is wrong half the time"*). One string also
means the two guards cannot drift.

### 2.2 The backstop, and why it does not replace the guard

`isRestrictViolationOn(err, constraints)` in `src/lib/api-errors.ts`, beside
`isTransientDbError` and `isRecordNotFound` — that module's own docblock claims
the "what does this thrown value MEAN" lookup table and argues against splitting
it by importer. Both delete routes catch and map to the same 409.

Matching on the **constraint name**, measured rather than assumed:

```
teacherRoom.delete:     code=P2003 meta={"modelName":"TeacherRoom","constraint":"ClassTemplate_teacherRoomId_fkey"}
teacherRoom.deleteMany: code=P2003 meta={"modelName":"TeacherRoom","constraint":"ClassTemplate_teacherRoomId_fkey"}
room.delete:            code=P2003 meta={"modelName":"Room","constraint":"ClassTemplate_teacherRoomId_fkey"}
```

`modelName` differs between the routes — `room.delete` trips the constraint
*through* the `Room`→`TeacherRoom` cascade — so the matcher must key on
`constraint` alone. It takes a list, covering `Class_teacherRoomId_fkey` too:
the `Class` guard has the identical TOCTOU and no backstop today.

**Not a global `P2003` branch in `classifyApiError`.** Everywhere else in this
app a `P2003` means the server wrote a dangling reference — a defect that must
stay a 500 at `level: 'error'`. Relabelling those "still in use" would hide the
exact failure class this project hunts. `isUniqueConflictOn`
(`src/lib/unique-conflict.ts`) already sets the house precedent: match the
specific constraint, never the code class.

**The guard is load-bearing beyond its message, and this must be written beside
it.** The catch looks like it subsumes the pre-check — it does not. The catch
runs *after* the `DELETE` has taken its locks, so deleting the pre-check as
redundant silently reopens the deadlock with every test still green. A comment
at each guard says so.

### 2.3 `rooms/[id]` becomes one transaction

`:49-50` runs `teacherRoom.deleteMany` then `room.delete` un-transacted. Narrow,
but a failure between them leaves the teacher's private rental rates
(`TeacherRoom.rentalRate`, which CLAUDE.md calls "never shared between
teachers") deleted with the room still standing. Wrapped in `prisma.$transaction`.

**Corrected in review — this section's premise was incomplete.**
`TeacherRoom_roomId_fkey` is `ON DELETE CASCADE`
(`20260403092044_init/migration.sql:333`), so `room.delete` alone takes every
link and the `deleteMany` is redundant. The window described above therefore
exists only because of a statement that need not be issued at all; dropping it
would close the window outright, and wrapping is the more conservative of two
correct fixes. Kept as written — the explicit statement says what the delete
removes, and the transaction makes keeping it free — but the handler now
records the cascade beside it, because the `deleteMany` sits under a comment
insisting the *pre-check* is not redundant, and the two redundancy stories run
opposite ways.

That same cascade is what §2.2's measurement was showing: a `room.delete`
reporting `ClassTemplate_teacherRoomId_fkey` — a constraint declared on
`TeacherRoom` — is only possible because the cascade reaches the link first.

### 2.4 `docs/lock-order.md` gains the edge

985 lines and `grep -n "TeacherRoom"` returns nothing. A new section, in the
style of "The slot key is a wait edge", recording: the cycle, that the guard is
what closes it, and that removing the guard reopens it.

---

## 3. What proves it

Integration cases in `tests/integration/teacher-rooms-api.test.ts` and
`tests/integration/rooms-api.test.ts` — both already have `DELETE` describe
blocks covering the `Class` guard, and **neither has a single template case**
today. A unit case for the matcher in `src/lib/api-errors.test.ts`.

Each guard gets a recorded mutation: break it, capture the exact failure text,
restore, re-verify.

| # | Mutation | Must fail with |
|---|---|---|
| 1 | Drop the template count from `teacher-rooms/[id]` | 500 where 409 expected |
| 2 | Drop the template count from `rooms/[id]` | 500 where 409 expected |
| 3 | **Narrow the predicate to `ACTIVE_TEMPLATE_WHERE`** | the archived-template case only |
| 4 | Make the matcher accept any `P2003` | the unrelated-constraint case |

**Mutation 3 is the one that carries the design.** A test written only against an
*active* template stays green under it, so without an archived-template case the
predicate choice in §2.1 is asserted and not pinned — the "guard that cannot
fail" this project keeps shipping. The reproduction above used an archived
template precisely because that is the case the obvious implementation misses.

Mutation 4 uses a real-but-unrelated constraint name rather than an invented
one, so the assertion cannot pass by matching nothing.

**Added in review:** a fourth block in `src/services/room-deletion.test.ts`
provokes the real refused deletes and asserts on `meta.constraint` directly.
Everything else pins P2003 against a hand-built error, so nothing stood behind
the claim joining matcher to list — that Prisma really reports the constraint
name in that field. A Prisma upgrade moving it would have disarmed both
backstops with the whole suite green.

**Honestly unproven:** §2.3's transaction. Its window needs a concurrent write
between two adjacent statements, and this suite has no way to open it. It ships
as a correctness argument, not a tested behaviour, and the spec says so rather
than implying coverage it does not have.

---

## 4. What this does not do

- **No `lock_timeout` on the delete.** Considered and rejected: the residual
  wait is already bounded by the sweep's own 10 s transaction budget, and the
  deadlock detector fires at 1 s regardless, so a 2 s timeout buys a few seconds
  in a window that needs a template created *between* the check and the DELETE
  on a room that had none an instant earlier. Against that, it adds a lock-taking
  node to the ordering `template-lock-order.test.ts` defends — the trade #76
  already refused one module over (`room-archive.ts:146-147`).
- **No change to the archive door.** `ACTIVE_TEMPLATE_WHERE` stays correct there;
  §2.1 explains why the two predicates differ on purpose.
- **No `DELETE` verb for templates.** Whether a teacher should be able to erase a
  template — which would make these rooms deletable again — is a product question
  this branch does not open.
- **#104 is unaffected** (no `lock_timeout` at the four pre-existing row-lock
  sites), and **#229 is unaffected**.
