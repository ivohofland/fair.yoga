# Student push card — implementation plan (#818)

**Spec:** `docs/superpowers/specs/2026-10-11-student-push-card-design.md`

**Goal:** a one-time, dismissible card on `/bookings` offering to turn on push
for this phone, with its dismissal stored per student.

## Global constraints

- TypeScript strict; no `any`. Test-first: each behaviour's test is written and
  seen failing before its code.
- Services/route conventions: thin route, `withErrorHandler`, `requireStudent`,
  `respondOk` / `respondUnchanged` (`src/lib/api-utils.ts`). "Already done"
  answers `respondUnchanged`, never an error.
- Migration only via `pnpm exec prisma migrate dev --name student_push_card_dismissed`;
  never `db push`, never hand-edit an applied migration.
- Comment discipline (CLAUDE.md): comments annotate their own code; no counts or
  rosters in prose; no correction history.
- Design system: no motion, sand-soft card, `type-*` styles only; copy below is
  exact.
- Task order is load-bearing: Task 3 consumes Task 1's route and Task 2's
  `PushOfferCard`.
- Worktree: run integration tests against the worktree's own app
  (`pnpm run worktree:up` once; `INTEGRATION_BASE_URL` is read automatically).
  Never touch the dev server on :3000. Node 24 is required
  (`~/.nvm/versions/node/v24.21.0/bin` on `PATH`).
- Stage exact paths; quote paths containing parentheses.

## Task 1 — dismissal store and route

**Files:** `prisma/schema.prisma`, new migration, new
`src/app/api/account/student-push-card/route.ts`, an integration test file
under `tests/integration/` (new, e.g. `student-push-card-api.test.ts`),
`docs/data-model.md`.

1. Add `pushCardDismissed Boolean @default(false)` to `model Student`, placed
   with the other preference columns (after `pushInvitations`). Generate the
   migration with the command above.
2. Integration tests first (follow the session/fixture helpers the existing
   integration files use, e.g. `tests/integration/teacher-signup-api.test.ts`
   and `tests/helpers.ts`):
   - a student session POSTs → 200, `Student.pushCardDismissed` is true;
   - a second POST → 200 with `outcome: 'unchanged'`, flag still true;
   - a teacher-only session → 403, and an unauthenticated request → 401;
   - **one account with both a Teacher and a Student**: the student POST
     leaves `Teacher.skippedOnboarding` unchanged; a teacher
     `POST /api/account/onboarding { step: 'push' }` leaves
     `Student.pushCardDismissed` false.
3. Route: `POST` only, no body read. `requireStudent`; then
   `prisma.student.updateMany({ where: { id, deletedAt: null, pushCardDismissed: false }, data: { pushCardDismissed: true } })`.
   `count === 1` → `respondOk({ dismissed: true })`; `count === 0` →
   `respondUnchanged<{ dismissed: boolean }>({ dismissed: true })`. A short
   docblock stating what the route records and why the write is conditional.
   If the project keeps a census of API routes or signed-in sections
   (`src/proxy.ts`, any route-census test), register the route there as the
   neighbours in `src/app/api/account/` are.
4. `docs/data-model.md`, Student (core) table: one row for
   `push_card_dismissed` — boolean, default false — "Set once when the student
   dismisses the push card on `/bookings` (#818); only that card reads it."
   Match the table's existing column-name style.
5. **Break the guard:** remove `pushCardDismissed: false` from the `where`
   → the "second POST is unchanged" test fails; record the exact failure text
   in the report; restore; re-run green.

## Task 2 — extract `PushOfferCard`

**Files:** new `src/components/push/push-offer-card.tsx`,
`src/components/schedule/push-card.tsx`.

1. Move `PushCard`'s body into `PushOfferCard` with props
   `{ dismissed: boolean; vapidPublicKey: string | null; description: ReactNode; dismissControl: ReactNode }`.
   Heading ("Get notifications on this phone"), gate, Turn on handler,
   busy/failed state and retry line move verbatim, along with the docblock and
   inline comments that annotate them (adjust "the teacher" to "the person"
   where the comment now covers both sides).
2. `PushCard` keeps its exported name and props and renders `PushOfferCard`
   with its existing `<p>` copy as `description` and its existing
   `OnboardingSkipButton` as `dismissControl`.
3. **`src/components/schedule/push-card.test.tsx` must pass unmodified** — the
   proof that behaviour is preserved. Do not edit it.
4. **Break the guard:** temporarily delete the `permission !== 'default'`
   check in `PushOfferCard` → the teacher test's state matrix fails; record
   the text; restore.

## Task 3 — `StudentPushCard` on `/bookings`

**Files:** new `src/components/student/push-card.tsx` and
`src/components/student/push-card.test.tsx`,
`src/app/(student)/bookings/page.tsx`, `docs/information-architecture.md`.

1. Tests first (`components` vitest project), mocking `useCoarsePointer`,
   `usePushDevice` and `enablePush` the way `push-card.test.tsx` does, and
   reusing its tethered `STATES` pattern:
   - renders only for `off` + `default` + coarse + not dismissed, across every
     `PushDeviceState` × each permission (incl. `null`) × coarse/fine ×
     dismissed;
   - the copy is exact (below) and the Settings link's `href` is
     `/account/notifications`;
   - Turn on → `on` hides, `blocked` hides, `failed` shows
     "Notifications weren't turned on. Try again." and keeps the button;
   - Dismiss POSTs `/api/account/student-push-card` and calls `router.refresh()`
     (`routerRefresh` from `tests/setup/components`); a non-ok response leaves
     the Dismiss button enabled and does not refresh.
2. `StudentPushCard({ dismissed, vapidPublicKey })` renders `PushOfferCard` with:
   - description: `A heads-up when a waitlist spot opens for you or a class you booked changes. Booking emails still come as they do now — you choose which messages in ` + link "Settings" → `/account/notifications` + `.`
   - dismissControl: a `button type="button"`, label "Dismiss",
     `aria-label="Dismiss the notifications card"`, same classes as the
     teacher's Dismiss, disabled while posting; on ok → `router.refresh()`;
     on a non-ok response → `console.error('[student-push-card] refused', { status })`
     and re-enable; on a throw → `logRequestFailure('student-push-card', {}, err)`
     (`@/lib/client-errors`) and re-enable.
3. `/bookings`: select `pushCardDismissed` in the existing `student` query and
   render `<StudentPushCard dismissed={student.pushCardDismissed} vapidPublicKey={readVapidConfig()?.publicKey ?? null} />`
   between the heading row and `<UpdatesStrip>`.
4. `docs/information-architecture.md`: a **Student push card** paragraph right
   after the **Push card** paragraph: on the student's home (`/bookings`),
   same eligibility and Turn on behaviour as the teacher's card; Dismiss is
   stored on the student (`pushCardDismissed`), independent of the teacher's
   dismissal on a two-hat account; Settings → Notifications (`/account/notifications`)
   is the way back.
5. **Break the guard:** change the Dismiss URL to a different path → the
   Dismiss test fails; record; restore.
6. Run `pnpm run verify` (typecheck, lint, all vitest projects) green before
   reporting.
