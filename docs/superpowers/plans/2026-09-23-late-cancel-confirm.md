# Late-cancel confirm copy (#664)

**Goal:** The student's cancel confirm says the deadline has passed when it has. The warning and the charge read the deadline from one place.

**Path:** bounded, so no spec. The design was agreed in chat on 2026-09-23. Decisions from that gate:
- Extract the deadline at **every** inline site, not only the two the issue names.
- Use the after-deadline copy **exactly as the issue words it**.

## Premise, measured

- The confirm text ignores the deadline: `src/components/student/cancel-booking-button.tsx`, the `confirming` branch. **Holds.**
- The deadline is computed inline in **three** places, where the issue names one:
  - `DELETE /api/registrations/[id]` computes `DEADLINE_HOURS[...] ?? 24`, then class start minus hours, and charges when `now > deadline`.
  - `getWaitlistWindow` (`src/services/waitlist.ts`) returns `frozen` when `now >= deadline`.
  - `broadcastStillStands` (`src/services/waitlist-reconciliation.ts`) computes the claim-window start as class start − (hours + 1).
  - Re-derive with: `grep -rn "DEADLINE_HOURS\[" src`.
- "A late cancel frees no spot" is **inaccurate**. The late branch calls `promoteAfterCancel`, and the seat opens for a direct booking. Only the waitlist is frozen. The agreed copy makes no claim about the spot, so this correction belongs in the PR body only.
- A late cancel notifies only the student. The teacher sees the "Late cancel" label on the roster (`attendance-list.tsx`). The copy "lets your teacher know" was kept deliberately at the gate.

## Task 1 — one deadline function, one comparison (lands first; Task 2 imports both)

**Files:** `src/services/waitlist.ts`, `src/lib/cancel-deadline.ts` (new), `src/app/api/registrations/[id]/route.ts`, `src/services/waitlist-reconciliation.ts`, and their unit tests.

- **`cancelDeadlineInstant(entry: { date; startTime }, cancelDeadline: CancelDeadline, timeZone: string): Date`** in `src/services/waitlist.ts`, next to `DEADLINE_HOURS`.
  - It returns `classStartInstant(entry, timeZone)` minus `DEADLINE_HOURS[cancelDeadline]` hours.
  - It lives server-side because `classStartInstant` logs through pino (`@/lib/log`).
- **`isPastCancelDeadline(deadline: Date, now: Date): boolean`** in the new `src/lib/cancel-deadline.ts`.
  - It returns `now > deadline`, which is the `DELETE` handler's current boundary, unchanged.
  - The module is pure, with no imports beyond types, so the client button can import it.
- **Adopt the instant at all three sites:**
  - The `DELETE` handler also uses `isPastCancelDeadline`. Its `?? 24` fallback goes away, because the lookup is total over the enum.
  - `getWaitlistWindow` keeps its own `>=` for `frozen`. The waitlist freezing at the exact deadline instant is a separate rule from the charge, so it is not changed here.
  - `broadcastStillStands` becomes the instant minus one hour.
- **Tests (write them first):**
  - `cancelDeadlineInstant`: one deadline in a non-UTC zone across a DST boundary, plus one per enum member, or a loop over `DEADLINE_HOURS` keys.
  - `isPastCancelDeadline`: before, exactly at the deadline (`false`), and one ms after (`true`).
  - The existing `getWaitlistWindow` and reconciliation tests should pass without edits. They are what shows the extraction is behaviour-preserving.
- **Prove it bites:** flip `>` to `>=` in `isPastCancelDeadline`, record the failing test and its message, then restore. Change the hours arithmetic in `cancelDeadlineInstant` (for example, drop the `* 60`), record which tests fail, including existing waitlist ones, then restore. Finish with `git status` clean.

## Task 2 — the button decides at tap time

**Files:** `src/components/student/cancel-booking-button.tsx` and its test, `src/app/(student)/bookings/page.tsx`.

- **New prop `cancelDeadlineAt: string`** (ISO instant). The page sets it to `cancelDeadlineInstant(cls.calendarEntry, cls.cancelDeadline, cls.calendarEntry.teacher.defaultTimezone).toISOString()`.
  - `cancelDeadline` (the enum) stays, for the before-deadline label.
  - Check that the page's query selects everything the call needs.
- **At the first "Cancel booking" tap, the button stores `isPastCancelDeadline(new Date(cancelDeadlineAt), new Date())` in the confirming state.**
  - Never on render, and never from a server boolean, because a server snapshot goes stale.
  - The text does not change while the confirm stays open. The server decides at write time, and the bookings-page caption reports a late cancel afterwards.
- **Copy:**
  - Before the deadline (unchanged): "Cancel this booking? Free until {label} before class — after that the class is still charged."
  - After the deadline: "The cancellation deadline has passed, so you'll still pay your share of this class. Cancelling lets your teacher know you won't be there."
  - The buttons stay **Cancel booking** / **Keep booking**.
- **Tests:** fake timers with `vi.setSystemTime` (pattern: `src/components/schedule/class-list.test.tsx`).
  - Before shows the before copy. After shows the after copy. Exactly at the deadline shows the before copy, which matches the server's `>`.
  - A test where the clock moves past the deadline between render and tap shows the after copy. This is the stale-snapshot case the issue names.
  - Existing tests get the new prop.
- **Prove it bites:** replace the tap-time comparison with a constant `false`, then with `>=`. Record the failing tests for each, then restore, and check `git status` is clean.

## Verification

- `pnpm run verify` in the worktree, after `worktree:setup` / `worktree:up`.
- The integration suite covers the `DELETE` late/early branches (`tests/integration/registrations-api.test.ts`). No integration file is expected to change.
