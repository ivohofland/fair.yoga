# The API error contract: registered codes, and "already done" is not an error

**Issue:** #197 (folds #307)
**Date:** 2026-09-17
**Status:** design — direction agreed with Ivo at four gates (scope, the
settled rule, registry strictness, what to fold)

## 1. What the issue says, and what is there

#197 was written on 2026-08-11 against a tree that has since moved a long way.
Its complaint holds — a refusal written for a developer reaches a user
verbatim, and a client cannot tell "you already did this" from "this failed" —
but almost every number and one structural claim has moved.

| #197 says | Measured on this branch's base (`5332af45`), census at `4e1ec6e4` |
|---|---|
| "Eighteen API endpoints" in the conflict family | **232** state-dependent error rows across **59** mutating pairs with a client caller (§2). **47** of those rows are reachable by the user's own retry. |
| "Only 4 of the 18 pass a machine-readable code" | **96 of 232** rows carry a code; **50** distinct code strings, every one local to its route. |
| "`readErrorMessage` discards codes entirely" | Still true, and `readErrorMessage` has 38 caller files. But a code-aware helper, `readError` (`src/lib/client-errors.ts:30`), **already exists** — #197's piece 2 is half built. Two client files branch on a code at all (`set-up-student-side.tsx` via `readError`, `share-room-button.tsx` by hand). |
| `Invalid transition: cannot move from "open" to "open"…` | **Holds**, and the complete route sends the same shape for `completed → completed`. |
| `Cannot undo: current status is "pending". Must be "paid".` — `payments.ts:158` | **Moved and widened**: now `… Must be "paid" or "not charged".` at `payments.ts:165`. |
| `Cannot mark payment as paid: …` | **Holds** (`payments.ts:102`). Two more of the family exist: not-charged (`:200`) and remind (`:277`). The overdue variant (`:126`) belongs to `markPaymentOverdue`, which has no non-test caller and never reaches the wire. |
| `Teacher-room not found` / `Teacher link not found` / `Contact not found` | **All hold** (`teacher-rooms/[id]/route.ts` ×4, `teacher-links/[teacherId]/route.ts:50`, `invitations/[id]/shared.ts:47`). |
| `Student is already registered for this class` is "already fine" | **Fine in wording, wrong in reach.** A student whose own first booking took the last seat is told `Class is full` on retry, because the capacity check (`registrations/route.ts:175`) runs before the already-registered check (`:183`). |

The issue's own census (22 idempotent / 18 conflict / 7 duplicate) was
superseded before this spec: `2026-08-11-retry-safe-endpoints-design.md` §2
re-measured it as 56 pairs with 20 CONFLICT and noted that the prior census had
never published its members. This spec's census asks a different question — not
"what does a sequential retry get" but "which error rows exist, how do they
read, what code do they carry, and can the user's own retry reach them" — so
its totals are not comparable to either.

**#623 landed between the census and this branch** (an account holds any
number of erased profiles and at most one live one of each kind; the unique
index on `accountId` is partial). It retires one census finding outright:
census C's "an account whose student half is erased can never join as a
student again" is no longer true — `Student_account_live_unique` does not see
the erased row. It also means a collision on that index now proves a **live**
profile exists, which §5 relies on.

## 2. The census

Three subagents read every exported POST/PUT/PATCH/DELETE under `src/app/api/`
at `4e1ec6e4`, one domain each, against a shared brief. Their full tables are
the appendix — **`2026-09-17-api-error-contract-census/`** (`a-classes-templates.md`,
`b-money-bookings-rooms.md`, `c-people-auth-account.md`) — so every total below
can be diffed row by row rather than trusted.

"State-dependent" means a non-2xx the request gets because of stored state —
404 not-found/not-owned, 409, a 400/422 that depends on what is stored. Out of
scope and counted separately: 401/403 from the session guards, `parseBody`
failures, 429s, and input-shape 400s.

| | A | B | C | Total |
|---|---:|---:|---:|---:|
| Mutating pairs with a client caller | 14 | 19 | 26 | **59** |
| Pairs with no client caller | 5 (cron) | 0 | 0 | 5 |
| State-dependent rows | 79 | 95 | 58 | **232** |
| DEV / DEV? / USER | 13 / 12 / 54 | 16 / 23 / 56 | 3 / 21 / 34 | **32 / 56 / 144** |
| Coded / uncoded | 47 / 32 | 20 / 75 | 29 / 29 | **96 / 136** |
| ALREADY / BOTH | 2 / 10 | 10 / 10 | 5 / 10 | **17 / 30** |

32 + 56 + 144 = 232 ✓. 96 + 136 = 232 ✓. 17 + 30 = **47** rows a user's own
retry can reach. Census C counts a shared response (`casMatchedNothing`,
`shared.ts`) once per pair that reaches it, so rows are sites × pairs, not
distinct strings.

**Distinct codes: 50.** A lists 24 (one of them, `CLASS_NOT_ENDED_YET`,
unreachable through its route); B adds 7 new ones (its eighth, `NOT_FOUND`,
repeats A's); C adds 19 (18 on in-scope rows plus `NOT_YOUR_PROFILE`).
24 + 7 + 19 = 50. `VALIDATION_ERROR` is a 51st string in `src/`, on an
input-shape 400 and so outside the census.

**Uncoded 409s**, measured on this branch rather than taken from the census,
because §4.2 makes them compile errors:

```bash
# uncoded: 409 is the last argument, with or without a trailing comma
rg -U -n --type ts -g '!*.test.ts' 'respondError\((?:[^()]|\([^()]*\))*?,\s*409\s*,?\s*\)' src
# coded: 409 is followed by another argument
rg -U -n --type ts -g '!*.test.ts' 'respondError\((?:[^()]|\([^()]*\))*?,\s*409\s*,\s*[A-Za-z_\x27]' src
```

→ **26** uncoded sites: 15 files with one each, `registrations/[id]/route.ts`
with 7, `registrations/route.ts` with 4 (15 + 7 + 4 = 26); and **49** coded.
The `,?` matters — four of the uncoded calls are multi-line with a trailing
comma, and a pattern that treats any comma after `409` as "a code follows"
counts them as coded. Neither count sees a 409 passed through a variable (the
transition route's status map, the cancel service's `httpStatus: 409 as
const`, the template routes' `SLOT_TAKEN` maps); the compiler will, which is
the census that matters for §4.2.

**Rows verified by hand** before this spec relied on them: the capacity-before-
duplicate order (`registrations/route.ts:175-189`); `claimSpot`'s
`findUniqueOrThrow` (`waitlist.ts:647`) reaching `classifyApiError` as a 500;
`join-as-student.tsx:26` treating any 409 as success; the complete route's
blanket `respondError(result.error, 409)` (`classes/[id]/complete/route.ts:33`);
`booking-sign-in.tsx:38` ignoring `delivered`; and the room DELETEs'
unguarded `delete` after a plain read (`rooms/[id]/route.ts`,
`teacher-rooms/[id]/route.ts`).

## 3. Decisions

| Gate | Decision |
|---|---|
| Scope | **Contract + replay set + DEV copy.** A shared typed registry; every row a user's own retry can reach stops rendering red; the 32 DEV rows get product copy; integration tests pin codes. The 56 DEV? rows stay out, except where a touched delete gains `NOT_FOUND`. |
| The settled rule | **2xx `outcome: 'unchanged'`** for an outcome the server can prove, extending #98's toggle rule. A deleting client treats its own 404 `NOT_FOUND` as done. |
| Registry strictness | **A code fixes its status; a 409 needs one.** Compile-time on both counts. |
| Fold | Wrong copy/code on touched rows; the P2025 500s; **#307**. |

## 4. The contract

### 4.1 The registry — `src/lib/api-error-codes.ts`

A new module with **no imports that cannot run in a browser**, so client
components can import it.

```ts
export type ApiErrorStatus = 400 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

export const API_ERROR_STATUS = {
  NOT_FOUND: 404,
  PAYMENT_WAIVED: 409,
  // …every code, once
} as const satisfies Record<string, ApiErrorStatus>;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
export type StatusOf<C extends ApiErrorCode> = (typeof API_ERROR_STATUS)[C];
/** The codes registered at status `S`. */
export type CodeWithStatus<S extends ApiErrorStatus> = {
  [C in ApiErrorCode]: StatusOf<C> extends S ? C : never;
}[ApiErrorCode];
export function isApiErrorCode(value: unknown): value is ApiErrorCode;
```

`ApiErrorStatus` is the union of statuses a code may carry, not of every status
the app sends; widening it is a deliberate one-line edit, as `ApiFailure`'s
status union already is.

**Migration of the existing 50.** Every code moves in under its current name,
with three kinds of exception, each named in §6's table:

- **Retired**, because §5 turns its every site into a 2xx: `ALREADY_SHARED`,
  `ALREADY_STUDENT`. Deleting the entry turns every remaining comparison
  against it into a compile error, which is how the client branches in
  `share-room-button.tsx` and `set-up-student-side.tsx` are found.
- **Renamed**, where a name only made sense inside one route and is ambiguous
  in a shared registry: `DUPLICATE` (teacher-rooms) → `ROOM_ALREADY_LISTED`.
  Its only readers are tests.
- **Re-pointed**, where a site sends a code whose meaning is false for it:
  teacher-profile's ticket-path email collision sends `ACCOUNT_EXISTS`, not
  `ALREADY_TEACHER` (§7).

The inline `'ROOM_IN_USE'` literal at `teacher-rooms/[id]/route.ts:120` goes;
`ROOM_IN_USE_CODE`/`ROOM_IN_USE_RACE_CODE` in `room-deletion.ts` become
registry references.

**Each existing code must be checked to have exactly one status before it
moves in.** The census found none sent at two statuses, but it read for
messages, not for this; the plan makes it an explicit step, and a code that
does carry two is split rather than widened.

### 4.2 `respondError`

Two overloads over one unexported implementation:

```ts
export function respondError<C extends ApiErrorCode>(
  message: string,
  status: NoInfer<StatusOf<C>>,
  code: C,
): NextResponse;
export function respondError(
  message: string,
  status: Exclude<ErrorStatus, 409>,
): NextResponse;
```

`ErrorStatus` is the union of every error status the app sends uncoded today
(the compiler enumerates it; it is at least 400, 401, 403, 404, 429, 500, 503).

- A 409 with no code matches neither overload.
- A code with the wrong status fails the first overload. `NoInfer` is what makes
  that true: `C` is inferred from `code` alone, then `status` is checked against
  it. Without `NoInfer`, TypeScript is free to infer `C` from both arguments.
- A site passing `number` fails both, and gets typed.
- `withErrorHandler` calls the unexported implementation directly, because its
  argument is a union no single overload accepts.

### 4.3 `classifyApiError`

`ApiFailure` becomes a union whose 409 arm requires `code`:

```ts
type ApiFailure =
  | { status: 409; code: CodeWithStatus<409>; message; logMessage; level; detail? }
  | { status: 500 | 503; code?: ApiErrorCode; message; logMessage; level; detail? };
```

`withErrorHandler` passes `failure.code` through. The fallbacks gain codes:

| Branch | Code |
|---|---|
| Terminal trigger (`That class can no longer be changed`) | `CLASS_TERMINAL` — already means exactly this at `classes/[id]/route.ts` |
| Escaped P2002 | `UNIQUE_CONFLICT` (new); message rewritten, §6 |
| `ScheduleRule_teacher_slot_excl` | the existing code for "a template holds this weekday slot, holder unknown", if one exists with that exact meaning; otherwise new `RULE_SLOT_TAKEN`. The plan decides by reading the template routes' `SLOT_TAKEN` maps. |
| `CalendarEntry_teacher_slot_excl` | same rule; otherwise new `ENTRY_SLOT_TAKEN` |
| Transient (503) | no code — unchanged |

**No P2025 branch.** A blanket `P2025 → 404` would relabel a genuine bug — an
update whose `where` is wrong — as "not found". §7 catches P2025 at the five
sites where it means a row vanished, and nowhere else.

### 4.4 `respondUnchanged`

Beside `respondTyped`, with the same `T = never` + `NoInfer` shape:

```ts
export function respondUnchanged<T = never>(data: NoInfer<T>): NextResponse {
  return NextResponse.json({ data, outcome: 'unchanged' }, { status: 200 });
}
```

- **Status 200**, including on endpoints whose applied success is 201: nothing
  was created.
- **`outcome` sits beside `data`**, not inside it. Applied bodies are resources,
  arrays and result objects; there is no uniform place inside them, and a
  client that reads `data` gets the same shape either way.
- **`data` has the same type as the endpoint's applied `data`** wherever a
  client reads it. Where no client reads the body (the census found most check
  only `res.ok`), the plan may return a smaller shape, and must say so per
  endpoint.
- #98's `action: 'unchanged'` on the template toggles is that service's own
  result discriminant and stays as it is.

### 4.5 Client helpers — `src/lib/client-errors.ts`

- `readError` returns `{ code?: ApiErrorCode; message: string }`. A wire code
  that fails `isApiErrorCode` becomes `undefined` — a client comparing against
  a code the server has since retired should be a compile error, not a silent
  mismatch.
- **#307**: the `catch` in `readError` calls `console.error` with the response
  status and URL before returning the fallback. `readErrorMessage` is
  reimplemented over `readError`, so it inherits the log and keeps its
  signature for its 38 callers.
- New `src/lib/client-errors.test.ts` (§8), which is #307's acceptance.

## 5. What counts as already done

### 5.1 The rule

> A request whose goal the server can **prove** already holds answers **200
> `outcome: 'unchanged'`**, performs no write, and has no side effect.
> "Prove" means the stored state equals what the request asks for, **including
> every value the request carries**. The check runs **after** authentication and
> ownership — never before, or "unchanged versus 404" becomes an existence
> oracle — and **before** any status, window or capacity refusal, so a retry is
> never refused for a state its own first attempt created.

A request that carries values the stored row does not match is not a retry of
the request that created that row. Answering it `unchanged` would discard what
the user typed, which is why teacher-rooms, invite and teacher-profile compare
values.

This rule, and §6.1's copy rule, go into `docs/technical-architecture.md` (The
Services Layer), and CLAUDE.md's *Development Principles* gains one short
paragraph pointing there, beside the `FireAndForget` one.

### 5.2 Group (i) — provable, now `unchanged`

| Endpoint | `unchanged` when | Otherwise |
|---|---|---|
| `POST /api/classes/[id]/transition` | class already in the target status | `ILLEGAL_TRANSITION` per pair (§6.2), `CLASS_CANCELLED`, `CONCURRENT_MODIFICATION`, `NOT_FOUND` 404 |
| `POST /api/classes/[id]/complete` | already `completed` | the route maps reasons to statuses and codes as the transition route does, instead of a blanket 409: `NOT_FOUND` **404**, `CLASS_CANCELLED`, `ILLEGAL_TRANSITION` |
| `POST /api/classes/[id]/cancel` | already cancelled | `CLASS_NOT_CANCELLABLE` (started / finished), `NOT_FOUND` 404 |
| `POST /api/payments/[id]/paid` | `paid` | `PAYMENT_WAIVED` (`not_charged`) |
| `POST /api/payments/[id]/not-charged` | `not_charged` | `PAYMENT_ALREADY_PAID` (`paid`) |
| `POST /api/payments/[id]/unpaid` | `pending` or `overdue` — both are "unpaid" to the teacher, and a reminder sweep can move `pending` to `overdue` between the two requests | none remains |
| `POST /api/payments/[id]/remind` | inside the cooldown — a reminder was just sent, by this teacher or the sweep | `PAYMENT_SETTLED` (`paid` / `not_charged`) |
| `POST /api/registrations` | an **active** registration for (class, student) exists. Checked after the roster and class-ownership gates, **before** the class-status and capacity checks. The P2002 catch (`:345`) re-reads and answers the same. | `CLASS_FULL`, `CLASS_NOT_BOOKABLE`, `CLASS_CANCELLED` |
| `POST /api/waitlist/claim` | an active registration for (class, student) exists. Checked after the class-cancelled/not-open check, **before** the window, capacity and entry checks. | `CLASS_CANCELLED`, `CLASS_NOT_BOOKABLE`, `WAITLIST_FROZEN`, `CLAIM_NOT_OPEN`, `SPOT_TAKEN`, `NOT_ON_WAITLIST`, `NOT_FOUND` 404 |
| `DELETE /api/registrations/[id]` (all three "already cancelled" sites) | already `cancelled` or `late_cancel` | `CLASS_TERMINAL` (per-action message) |
| `DELETE /api/waitlist/[id]` | entry `removed` | `WAITLIST_ENTRY_INACTIVE` (`expired` / `promoted` / `claimed`); `NOT_FOUND` 404 |
| `POST /api/rooms/[id]/publish` | already shared (both sites) | — |
| `POST /api/teacher-rooms` | a **non-archived** link exists whose `capacityOverride`, `rentalRate` and `equipmentNotes` equal the request's effective values (both sites) | `ROOM_ALREADY_LISTED` (values differ), `ROOM_ARCHIVED` (link archived) |
| `POST /api/account/student-profile` | the session already has a live student side; or the create collides on `accountId` or (session path) `email` — under #623's live-only index that proves a live student side, re-read to return its id. The session path's names come from the teacher row, not from the user, so no value comparison is needed. | ticket path: `ACCOUNT_EXISTS` |
| `POST /api/account/teacher-profile` | a live teacher side exists (pre-check, or a session-path collision on `accountId`/`email`/`pageSlug`, re-read) **and** its `firstName`, `lastName`, `bio`, `pageSlug` and effective `defaultTimezone` equal the request's | `ALREADY_TEACHER` (values differ); `SLUG_TAKEN` (slug held by another teacher); ticket path: `ACCOUNT_EXISTS` |
| `POST /api/students` (invite) | a `pending` invitation for (teacher, email) exists with the same `firstName` and `lastName`; answers its id | `ALREADY_INVITED` (names differ), `ALREADY_LINKED`, `DECLINED`, `CONTACT_CHANGED` |
| `POST /api/invitations/[id]/respond` | the invitation's status already equals the requested answer — and, for `accept`, the teacher link is live. The service's `NOT_PENDING` result gains the current status so the route can tell. | `ALREADY_ANSWERED`, `STUDENT_ERASED`, `NOT_FOUND` 404 |

Retired by this table: `ALREADY_SHARED`, `ALREADY_STUDENT`. `ALREADY_TEACHER`
and `ALREADY_INVITED` stay, narrowed to "differs from what you sent".

### 5.3 Group (ii) — deletes of a row that is gone

`DELETE` on rooms, teacher-rooms, studio classes, invitations and
teacher-links: every "gone" answer is 404 **`NOT_FOUND`**, and each deleting
component treats `NOT_FOUND` as success. A 403 stays an error.

The server cannot prove these are retries — "you deleted it" and "it never
existed" leave the same trace — which is why the rule lives in the client that
just asked for the row to be gone. It is only sound in a client that issued the
delete; a component reading some other endpoint's 404 must not borrow it.

**Concurrent twins too.** A double-click sends both DELETEs before either
commits; both pass the existence read and the loser's `delete` throws P2025.
At rooms and teacher-rooms that is a 500 today (§7). Every group-(ii) door's
concurrent path must answer `NOT_FOUND`; the plan verifies each door rather
than assuming the three not named here are already safe.

### 5.4 Group (iii) — creates that meet their twin

`DUPLICATE_CLASS_SLOT`, `DUPLICATE_STUDIO_SLOT`, the template slot codes and
`DUPLICATE_ROOM` stay refusals. Without a request id the server cannot tell a
retry from a second, deliberate create, and their copy already names the
conflicting entry — the right answer either way.

### 5.5 Group (iv) — left alone

- Single-use auth answers (magic-link verify, passkey challenge, handoff
  claim): no client displays the replay answer, and their uniformity is
  deliberate. §6 rewrites two of their messages; their behaviour stays.
- `PUT /api/studio-classes/[id]` crossing the teacher's local midnight
  (`STUDIO_CLASS_INCOME_RECORD`): the retry is refused because the row became
  an income record in between, which is the rule working.

## 6. Copy

### 6.1 The register

1. **The user's terms.** *This class, this payment, this room, your student.*
   Never a model or table name, a status literal, an id, or a list of valid
   values.
2. **What is true, and the next step when there is one.**
3. **"Someone else" only when the server knows it was not this user** — which
   §5's ordering now guarantees for bookings and claims.
4. **Full sentences, sentence case, ending with a period.** No `Invalid …`,
   `Cannot …: …`, `Must be …`; no apology. Applied to rows this branch touches;
   untouched punctuation is not swept.
5. **One code, one meaning.** A message may vary with the action or with the
   entry it names; the code does not change meaning between doors.
6. **Say what the UI says.** Where a message names a control or a section, it
   uses the label the UI shows. The plan checks each such message against the
   component that renders it.

### 6.2 Every row this branch rewrites or recodes

Current strings are as of `5332af45`. "→ unchanged" means the row stops being
a refusal (§5.2).

**Classes and templates**

| Door | Current | Replacement | Status · code |
|---|---|---|---|
| transition (route read) | `Class not found` | This class no longer exists. | 404 · `NOT_FOUND` |
| transition (service) | `Class not found: ${classId}` | This class no longer exists. | 404 · `NOT_FOUND` |
| transition, complete | `Class ${classId} is cancelled` | This class has been cancelled. | 409 · `CLASS_CANCELLED` |
| transition, complete | `Invalid transition: cannot move from "${from}" to "${to}". Valid transitions from "${from}": [...]` | from = to → unchanged; otherwise the table below | 409 · `ILLEGAL_TRANSITION` |
| transition | `Concurrent modification of class ${classId}` | This class was just changed elsewhere. Refresh and try again. | 409 · `CONCURRENT_MODIFICATION` |
| complete | `Class not found: ${classId}` (sent as **409**) | This class no longer exists. | **404** · `NOT_FOUND` |
| cancel | `This class is already cancelled.` | → unchanged | — |
| cancel | `Cannot cancel a class with status "${status}"` | `in_progress`: This class has already started, so it can't be cancelled. · `completed`: This class has already finished, so it can't be cancelled. | 409 · `CLASS_NOT_CANCELLABLE` |
| cancel | `Class not found` (404, service re-read) | This class no longer exists. | 404 · `NOT_FOUND` |
| `PUT /api/classes/[id]` | `Cannot update economic fields when settings are locked: ${fields}` | Prices and capacity are locked once the first student books. | 409 · `SETTINGS_LOCKED` |
| `PUT /api/classes/[id]` | `Cannot edit a class that is ${state}` | `completed`: This class has finished and can no longer be changed. · cancelled: This class has been cancelled and can no longer be changed. | 409 · `CLASS_TERMINAL` |
| `POST /api/classes` (both sites), `POST /api/class-templates`, `PUT /api/class-templates/[id]` | `Invalid teacher room` | That room isn't on your list any more. | 400 · `ROOM_NOT_ON_LIST` |
| `POST /api/class-templates` (FK race) | `This room is archived.` for a **deleted** room | re-read as PUT does (#231): deleted → the `ROOM_NOT_ON_LIST` row above; archived → unchanged wording | 400 / 409 · `ROOM_NOT_ON_LIST` / `ROOM_ARCHIVED` |
| `PATCH` on both template families | `Unarchive the template before activating it` | Wording per §6.1 rule 6 (the plan reads the label the recurring-class settings use); meaning unchanged | 409 · `TEMPLATE_ARCHIVED` |
| `withErrorHandler` P2002 fallback | `Resource already exists` | That already exists. Refresh to see the latest. | 409 · `UNIQUE_CONFLICT` |

`ILLEGAL_TRANSITION`, per (from, to) — `VALID_TRANSITIONS` has 4 × 4 = 16
cells: 4 are from = to (unchanged), 3 are valid, and the 9 below are refused.
The message comes from one function with an exhaustive `switch` on `from` and a
`never` default:

| from | to | Message |
|---|---|---|
| `draft` | `in_progress`, `completed` | Publish this class first. |
| `open` | `draft` | A published class can't go back to draft. |
| `open` | `completed` | Start this class before completing it. |
| `in_progress` | `draft`, `open` | This class has already started. |
| `completed` | `draft`, `open`, `in_progress` | This class has already finished. |

(2 + 1 + 1 + 2 + 3 = 9 ✓.)

**Payments**

| Door | Current | Replacement | Status · code |
|---|---|---|---|
| paid, unpaid, not-charged, remind | `Payment not found: ${paymentId}` (sent as **409**) | This payment no longer exists. | **404** · `NOT_FOUND` |
| paid | `Cannot mark payment as paid: current status is "${status}". Must be "pending" or "overdue".` | `paid` → unchanged · `not_charged`: This payment was marked not charged. Put it back to unpaid first. | 409 · `PAYMENT_WAIVED` |
| not-charged | `Cannot mark as not charged: current status is "${status}". Must be "pending" or "overdue".` | `not_charged` → unchanged · `paid`: This payment is already paid, so it can't be marked not charged. | 409 · `PAYMENT_ALREADY_PAID` |
| unpaid | `Cannot undo: current status is "${status}". Must be "paid" or "not charged".` | → unchanged (`pending` / `overdue`) | — |
| remind | `Cannot send a reminder: current status is "${status}". Must be "pending" or "overdue".` | This payment is already settled, so no reminder is needed. | 409 · `PAYMENT_SETTLED` |
| remind | `A reminder for this payment was just sent. Try again in a couple of minutes.` | → unchanged | — |

**Registrations and waitlist**

| Door | Current | Replacement | Status · code |
|---|---|---|---|
| `POST /api/registrations` | `Cannot register for a class with status "cancelled"` | This class has been cancelled. | 409 · `CLASS_CANCELLED` |
| `POST /api/registrations` | `Cannot register for a class with status "${status}"` (other statuses) | This class isn't taking bookings. | 409 · `CLASS_NOT_BOOKABLE` |
| `POST /api/registrations` | `Class is full` | This class is full. (own retry → unchanged) | 409 · `CLASS_FULL` |
| `POST /api/registrations` | `Student is already registered for this class` (P2002 race) | → unchanged | — |
| `POST /api/registrations` | `This student's account no longer exists` (teacher) / `This account has been deleted` (student) | wording kept, periods added | 409 · `STUDENT_ERASED` |
| `PUT /api/registrations/[id]` | `Cannot record attendance on a cancelled class` | This class has been cancelled, so attendance can't be recorded. | 409 · `CLASS_CANCELLED` |
| `PUT /api/registrations/[id]` | `Cannot record attendance on a cancelled registration` | This booking was cancelled, so attendance can't be recorded. | 409 · `REGISTRATION_CANCELLED` |
| `PUT /api/registrations/[id]` | "You can mark them attended once the class has started." — also sent for a `no_show` request | names the status the request asked for (§7) | 409 as today · a code named for "attendance can't be recorded before the class starts"; the plan reuses an existing one only if its meaning is exactly that |
| `DELETE /api/registrations/[id]` | `Cannot cancel a registration on a ${state} class` | This class has finished, so the booking can't be cancelled. (per state) | 409 · `CLASS_TERMINAL` |
| `DELETE /api/registrations/[id]` ×3 | `Registration is already cancelled` | → unchanged | — |
| `POST /api/waitlist` | `Cannot join the waitlist for a cancelled class` | This class has been cancelled. | 409 · `CLASS_CANCELLED` |
| `POST /api/waitlist` | `Cannot join the waitlist for a class with status "${status}"` | This class isn't taking waitlist sign-ups. | 409 · `CLASS_NOT_BOOKABLE` |
| `POST /api/waitlist` | `The class still has open spots — book directly instead` | The class still has open spots — book directly instead. | 409 · `CLASS_NOT_FULL` |
| `POST /api/waitlist` | `You are already registered for this class` | (wording kept, period added) | 409 · `ALREADY_REGISTERED` |
| `POST /api/waitlist`, respond, privacy PUT, teacher-links DELETE | `This account has been deleted` | (wording kept, period added) | 409 · `STUDENT_ERASED` |
| claim | `Cannot claim a spot in a cancelled class` | This class has been cancelled. | 409 · `CLASS_CANCELLED` |
| claim | `Cannot claim a spot in a class with status "${status}"` | This class isn't taking bookings. | 409 · `CLASS_NOT_BOOKABLE` |
| claim | `The waitlist is frozen — the cancellation deadline has passed` | The cancellation deadline has passed, so spots can no longer be claimed. | 409 · `WAITLIST_FROZEN` |
| claim | `Spots can only be claimed in the final hour before the deadline — before that the queue promotes automatically` | (wording kept, period added) | 409 · `CLAIM_NOT_OPEN` |
| claim | `The spot has already been claimed` | own retry → unchanged · otherwise: Someone else just took the spot. | 409 · `SPOT_TAKEN` |
| claim | `You are not on the waitlist for this class` | own retry → unchanged · otherwise wording kept, period added | 409 · `NOT_ON_WAITLIST` |
| claim | P2025 → `Internal server error` | This class no longer exists. | 404 · `NOT_FOUND` |
| `DELETE /api/waitlist/[id]` | `That waitlist spot is no longer active — refresh to see the latest.` | `removed` → unchanged · otherwise wording kept | 409 · `WAITLIST_ENTRY_INACTIVE` |
| `DELETE /api/waitlist/[id]` | `Waitlist entry not found` | This waitlist spot no longer exists. | 404 · `NOT_FOUND` |

**Rooms**

| Door | Current | Replacement | Status · code |
|---|---|---|---|
| `DELETE /api/rooms/[id]` | `Room not found` | This room no longer exists. | 404 · `NOT_FOUND` |
| `DELETE /api/rooms/[id]` | P2025 on a concurrent twin → `Internal server error` | This room no longer exists. | 404 · `NOT_FOUND` |
| publish ×2 | `This room is already shared` | → unchanged | — |
| `POST /api/teacher-rooms` ×2 | `Teacher-room link already exists` | identical live link → unchanged · values differ: This room is already on your list. Edit it there to change its details. · link archived: This room is in your archived rooms. Unarchive it to use it again. | 409 · `ROOM_ALREADY_LISTED` / `ROOM_ARCHIVED` |
| teacher-rooms PUT, PATCH, DELETE | `Teacher-room not found` | This room is no longer on your list. | 404 · `NOT_FOUND` |
| teacher-rooms PUT, PATCH, DELETE | P2025 → `Internal server error` | This room is no longer on your list. | 404 · `NOT_FOUND` |
| teacher-rooms DELETE | `ROOM_DELETE_BLOCKED_MESSAGE` ("…cannot be deleted. Archive it instead.") for the UI's **Unlink** | a per-door message that names removing the room from your list, not deleting it | 409 · `ROOM_IN_USE` / `ROOM_IN_USE_RACE` |
| teacher-rooms PATCH (archive) | inline `'ROOM_IN_USE'` | registry reference | 409 · `ROOM_IN_USE` |

**Studio classes** — `DELETE /api/studio-classes/[id]`: `Studio class not
found` and `That class is already gone.` keep their wording and gain
`NOT_FOUND`.

**People and auth**

| Door | Current | Replacement | Status · code |
|---|---|---|---|
| student-profile ×3 | `Account already has a student profile` | → unchanged | — |
| teacher-profile (pre-check, session collision) | `Account already has a teacher profile` | identical → unchanged · otherwise: You already have a teacher page. Edit it in Settings. | 409 · `ALREADY_TEACHER` |
| teacher-profile (ticket-path `email`/`accountId` collision) | `Account already has a teacher profile` · `ALREADY_TEACHER` | This email now has an account. Please sign in and add a teacher profile. (student-profile's wording) | 409 · `ACCOUNT_EXISTS` |
| teacher-profile, `PUT /api/teachers/[id]` | `Page address already in use` / `Page slug already in use` | one message: That page address is already taken. | 409 · `SLUG_TAKEN` |
| respond | `Invitation not found` | This invitation no longer exists. | 404 · `NOT_FOUND` |
| respond | `This invitation has already been answered` | same answer → unchanged · otherwise wording kept, period added | 409 · `ALREADY_ANSWERED` |
| `invitations/[id]/shared.ts` `NOT_FOUND()` (PUT, DELETE, resend) | `Contact not found` | This contact no longer exists. | 404 · `NOT_FOUND` |
| `invitations/[id]/route.ts` (post-CAS re-read) | `This contact changed while you were working on it. Reload and try again.` | wording kept | 409 · `CONTACT_CHANGED` (the invite refusal's code; same meaning) |
| `shared.ts` `DECLINED()` | `This person declined. You can archive this contact, but it cannot be removed.` — also sent for edit and resend | per door: remove keeps today's sentence; edit and resend each say what is refused for them | 409 · `DECLINED_IS_PERMANENT` |
| `shared.ts` `NOT_PENDING()` | `This person already accepted your invitation — they are now on your Students list. Reload to see them.` | drops the claim that they are on the list — an accepted row can outlive its link (census C, surprise 6) | 409 · `NOT_PENDING` |
| `POST /api/students` | `You have already invited this person — open their contact to resend or update their details.` | same names → unchanged · otherwise wording kept | 409 · `ALREADY_INVITED` |
| `DELETE /api/teacher-links/[teacherId]` | `Teacher link not found` | You're no longer connected to this teacher. (one answer for both causes, by design) | 404 · `NOT_FOUND` |
| magic-link verify | `Invalid or expired magic link` | This sign-in link has expired or was already used. | 400 · uncoded |
| passkey authenticate/verify | `Invalid or expired challenge` | This sign-in attempt expired. Please try again. | 400 · uncoded |

**Any other uncoded 409** the compiler surfaces keeps its wording and gains a
code named for its meaning; the plan lists each one it finds.

## 7. Folded fixes

Each is a defect on a row or client this branch already touches.

1. **Last-seat retry.** The capacity-before-duplicate order (§5.2).
2. **teacher-profile's ticket-path collision** answers `ALREADY_TEACHER` — "You
   already teach here / There is already a teacher page for {email}" — for an
   account that may be student-only. Now `ACCOUNT_EXISTS`, as student-profile
   already does. Untested today; gets a test.
3. **`SLUG_TAKEN`'s two messages** become one; the comment at
   `teachers-api.test.ts:131-133` claiming `profile-form` needs the code (it
   never reads it) is corrected.
4. **`DECLINED_IS_PERMANENT` and `NOT_PENDING` copy** (§6.2).
5. **POST class-templates' deleted-room race** (§6.2).
6. **P2025 → 404 `NOT_FOUND`** at five sites: `claimSpot`'s
   `findUniqueOrThrow` (a class a template archive deleted); teacher-rooms PUT
   and PATCH on a link deleted after the read; and the concurrent twin of the
   rooms and teacher-rooms DELETEs. Each is a targeted catch using
   `isRecordNotFound` (`api-errors.ts:311`). The 2026-08-11 retry-safe spec
   (§2.2 legend) named the two DELETEs and assigned the wart to #197.
7. **Client handling.**
   - `join-as-student.tsx:26`'s `res.status !== 409` goes; it keys on `res.ok`.
   - `teacher-privacy-card.tsx` maps every 403 to "no longer connected",
     including `NOT_YOUR_PROFILE`; it branches on `TEACHER_NOT_LINKED`. Its
     comment pointing at a deleted CRM-removal route is corrected.
   - `create-student-form.tsx:88` calls `res.json()` on an error response with
     no catch; it uses `readError`.
   - `student-count-editor.tsx:65-66` renders its error without
     `role="alert"`, so a screen reader never announces it; it gains one.
   - The `DELETE /api/invitations/[id]` comment calling the vanished-row case
     "the retry this route is meant to survive" becomes true at the client and
     is reworded to say where.
8. **`PUT /api/registrations/[id]`** answers a `late_cancel → no_show` request
   with "You can mark them **attended** once the class has started."
9. **Component tests mocking bodies the server never sends**:
   `mark-unpaid-button.test.tsx:208,227`, `outstanding-payment-row.test.tsx:414,517`,
   `add-walk-in.test.tsx:204`. Each mock is replaced by the body the server now
   sends.
10. **#307.** §4.5.

## 8. Testing

### 8.1 Type pins (unit, `@ts-expect-error`, as `api-utils.test.ts` pins `respondTyped`)

- `respondError`: a 409 with no code; a code with the wrong status; an
  unregistered code — each an expected error. A correct call compiles.
- `ApiFailure`: a 409 literal with no `code`.
- `respondUnchanged` with no type argument.
- `readError(...).code` is `ApiErrorCode | undefined` (an `Assert<Equals<…>>`
  pin, `src/lib/type-pins`).

### 8.2 Unit

- `client-errors.test.ts`: known code passes through; unknown code string →
  `undefined`; string-shaped `error` body; unreadable body → fallback **and**
  `console.error` called with status and URL. The same four for
  `readErrorMessage`.
- `api-errors.test.ts`: each 409 fallback carries its code.
- The transition copy function: every cell in §6.2's table; no message contains
  a quoted `ClassStatus` literal.

### 8.3 Integration

- **Group (i), per endpoint:** the identical second request → 200,
  `outcome: 'unchanged'`, and **no second side effect** (the count the first
  request moved — notifications, reminder timestamp, payment row, registration
  rows — is unchanged). The genuine counterpart → status **and code**. No new
  assertion reads a message.
- **Values matter:** teacher-rooms with a different rate → `ROOM_ALREADY_LISTED`;
  invite with different names → `ALREADY_INVITED`; teacher-profile with a
  different bio → `ALREADY_TEACHER`.
- **The last seat:** student A takes the last seat; A's retry → unchanged;
  student B → `CLASS_FULL`. The same pair for claim (unchanged / `SPOT_TAKEN`).
- **Ordering:** a teacher's request against another teacher's class, crafted so
  that the unchanged condition holds, still → 403. This is the only test that
  can see the check placed above the ownership gate.
- **Group (ii):** delete, delete again → 404 `NOT_FOUND`. For rooms and
  teacher-rooms, the concurrent twin too.
- **P2025 sites:** claim with an unknown `classId` → 404 `NOT_FOUND`. The
  teacher-rooms PUT/PATCH vanished-link race needs a deterministic interleave;
  the plan uses an existing lock-hold harness if one fits and otherwise tests
  at the narrowest seam that reaches the catch, and says which.
- **Rewritten, not deleted:** `waitlist-api.test.ts:268-278` (pins the old
  second-claim refusal); the comment at `registrations/route.test.ts:391-392`;
  every existing prose assertion on a row in §6.2, which becomes a code
  assertion.

### 8.4 Components

For each touched client: an unchanged 200 renders as success; the deleting
components render their own `NOT_FOUND` as done; any other code renders as an
error. §7.9's mocks are replaced.

### 8.5 Prove each guard bites

Each is a plan step: apply, record the exact failure, restore, re-verify.
Route-level mutations warm the route with a request first — `next dev`
compiles lazily — and integration runs target this worktree's own app
(`worktree:setup`, `worktree:up`), never `:3000`.

| Mutation | Must fail with |
|---|---|
| Remove the code from a 409 `respondError` | `tsc` overload error |
| Send a 409-registered code with status 404 | `tsc` error |
| Remove `NoInfer` from `respondError` | the wrong-status `@ts-expect-error` becomes unused — the pin proves the annotation is load-bearing |
| Move the active-registration check back below capacity | the last-seat test |
| Move a group-(i) check above its ownership gate | the ordering test |
| Drop teacher-rooms' value comparison | the different-rate test |
| Delete one case from the transition copy `switch` | `tsc` (`never`) |
| Remove `readError`'s `console.error` | `client-errors.test.ts` |
| Drop `outcome` from `respondUnchanged` | group-(i) integration tests |
| Remove a group-(ii) P2025 catch | the concurrent-twin test |

## 9. Documentation

- `docs/technical-architecture.md`, The Services Layer: the settled rule
  (§5.1), the register (§6.1), and how to add a code (registry entry, one
  status, a test asserting it).
- `CLAUDE.md`, Development Principles: one paragraph pointing there, beside the
  `FireAndForget` one.
- No list of codes or endpoints in `docs/` or in comments. The registry is the
  list.

## 10. Out of scope, filed, and let go

**Filed** (a defect a user will hit, not this branch's subject):

- `booking-sign-in.tsx:38` shows "Check your inbox — we sent you a sign-in
  link" whenever `POST /api/auth/student-signup` answers 200, including its
  `delivered: false` body when the send failed. A new student on a booking page
  during an email outage is told a link is on its way. `booking-name-step.tsx`
  already reads `delivered`. The same component and `login/page.tsx` replace a
  429's retry time with fixed copy — noted in the same issue, lower priority.

**Folded and closed:** #307.

**Retired, not filed:** census C's erased-student join finding (#623 fixed it,
§1).

**Let go**, with the blocking condition or the reason:

- **The 56 DEV? rows**, mostly generic `Access denied` 403s and `X not found`
  404s. Census C finds 15 of its 21 are never displayed. A register pass on the
  rest is taste, not a defect, and nothing in this branch makes it worse.
- **Ownership wording differs by family** (`Not your class` vs `Access
  denied`): same reason.
- **`TEMPLATE_BUSY`'s "busy, try again"** is also sent when a third request
  reversed the archive under the CAS (`rule-lifecycle.ts:640-672`). The advice
  is imprecise but the retry reaches the right state.
- **Three create pages hand-parse error bodies** and show network copy for a
  non-JSON error. #307 explicitly scopes call-site catches out; this branch
  follows it, except `create-student-form`, whose handler it rewrites anyway.
- **`POST /api/notifications/[id]/read` checks existence before ownership.**
  The distinguishable ids are server-minted UUIDs no caller can enumerate, and
  both callers ignore the response.
- **Unreachable race-fallback 403s** at `rooms/[id]/route.ts:222` and
  `publish/route.ts:100`: nothing in `src/` writes `Room.createdById` after
  create.
- **`markPaymentOverdue`'s DEV string** (`payments.ts:126`): no non-test caller.
- **Passkey verification mismatches** (census C, UNKNOWN): no client displays
  the answer.

## 11. Risks

- **`unchanged` can mask a genuine failure** if a route answers it without the
  stored state actually matching. §8.3 asserts the stored state after every
  unchanged answer, not only the marker — the same mitigation #98 used.
- **The ordering rule is invisible in a retry-only test suite.** §8.3's
  ordering test and §8.5's matching mutation are the only things that see it;
  both are required.
- **Renaming or retiring a code breaks a reader outside the repo.** There is
  none: the API has no external clients.
- **The overloads may fight inference at sites that build a response through
  a helper** (`clearDeclinedTicketCookie`, `casMatchedNothing`). The plan's
  first task is the type change alone, so the compiler's full site list exists
  before any copy task starts.
