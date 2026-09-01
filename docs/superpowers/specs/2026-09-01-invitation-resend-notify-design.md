# A corrected invitation address is never mailed — issue 173

**Date:** 2026-09-01 · **Issue:** 173 (spun out of #166 / PR #169) · **main @** `fcc36ae9`

## The defect, re-verified against current main

The issue's three findings all still hold, read fresh against `fcc36ae9`:

1. `POST /api/students` sends exactly once, fire-and-forget
   (`src/app/api/students/route.ts:141-186`). A failed send logs
   `{ err, teacherId, invitationId }` and nothing else happens.
2. No resend affordance exists anywhere — no route, no service function, no
   UI control. `DELETE /api/invitations/[id]` followed by a fresh `POST` works
   but is discoverable only by hitting `ALREADY_INVITED`.
3. `PUT /api/invitations/[id]` (`src/app/api/invitations/[id]/route.ts:109-183`)
   writes a changed `email` with no call to `notifyInvitee` and no
   recomputation of anything delivery-related.

**Two of the issue's own citations have drifted and are corrected here, not
carried forward:** the "no resend button yet" paragraph is at
`src/services/invitations.ts:51-52` today, not `46-47`; the "there is no
resend" `.catch` paragraph is at `src/app/api/students/route.ts:175-180`
today, not `197-201`. Both shifts are from unrelated edits between #166 and
now, not from anything this spec touches.

**The issue's own `resend`-census (23 lines) is stale and is not reused.**
Re-run today: `grep -rni "resend" src/ tests/ | wc -l` → 57 lines, most of
them unrelated to invitations (double-submit guards in the class/studio-class
forms, an announcements dedup test, `magic-link.ts`'s resend-token
reasoning, the `Resend` email SDK itself). The only two lines that are this
issue's actual claim — "no invitation-resend affordance exists" — are the two
just re-cited above. Counts belong to a `docs/` re-derivation, not a comment;
this line is that derivation, kept out of the code.

## Decision: an explicit resend route, not a notifying PUT

The issue's acceptance criterion 1 allows either. Chosen: a new
`POST /api/invitations/[id]/resend`, with `PUT` left untouched.

**Rejected: make `PUT` notify when `email` changes.** It only closes the
typo-correction half of the issue's title ("editing its address notifies
nobody") and does nothing for the other half ("cannot be resent") — a teacher
who suspects the original send never arrived, with no typo to fix, has
nothing to click. It would also mean touching `PUT`'s existing oracle-safety
reasoning (`notifyInvitee`'s docblock currently states, correctly, that `PUT`
not notifying is harmless) instead of leaving that reasoning alone.

**Rejected: both.** Two independent call sites into the same oracle-sensitive
`notifyInvitee` contract, for no requirement the issue actually states
("acceptance is either, not necessarily both"). More surface for the same
outcome.

An explicit route also has a direct sibling to follow:
`src/app/api/invitations/[id]/respond/route.ts` already establishes the
`[id]/<verb>` sub-route shape for this resource.

## The invariant that governs the whole design

**A record of "we attempted a send" must be written unconditionally, on
every attempt, regardless of whether `TeacherBlock` ends up withholding the
actual delivery.**

`inviteContact`'s docblock is explicit that a blocked and an unblocked
invitation must be indistinguishable to the teacher in every way except the
one field (`delivered`) that never reaches the wire — "the difference lives
only in `delivered`, which never reaches the wire." This spec adds a second
persisted fact about the row (when it was last (re)sent, and to which
address) specifically so the teacher can tell "sent" from "not sent" — and if
that fact were written only when delivery succeeds a block check, it becomes
a second, silent way to learn "this specific student blocked me": a blocked
contact would forever show "not yet sent" while every otherwise-identical
unblocked one advances. That is the exact harassment channel `TeacherBlock`
exists to close, reopened through a UI label instead of a response body.

So both write sites below write the marker before any block check runs, and
the marker's presence never depends on its outcome.

## Data model

Two new nullable columns on `Invitation`:

```prisma
model Invitation {
  // ...existing fields...
  lastNotifiedAt    DateTime?
  lastNotifiedEmail String?
}
```

Hand-authored `CHECK`s, following
`prisma/migrations/20260805074500_invitation_check_constraints/` exactly —
same nullable-safe lowercase shape as `Invitation_email_lowercase_check`, and
the same paired-nullability shape as `Invitation_responded_at_status_check`:

```sql
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_last_notified_email_lowercase_check"
  CHECK ("lastNotifiedEmail" IS NULL OR "lastNotifiedEmail" = lower("lastNotifiedEmail"));

ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_last_notified_pair_check"
  CHECK (("lastNotifiedAt" IS NULL) = ("lastNotifiedEmail" IS NULL));
```

Both columns are always written together (never one without the other) —
the pair check pins that the same way `_responded_at_status_check` pins
`respondedAt`/`status`.

**Rollout note, not a defect to fix here:** every `Invitation` row that
predates this migration has both columns `NULL`, even though most were
genuinely sent under the old fire-and-forget path — there is no historical
record to backfill from. Those rows will read "Not yet sent to this address"
until their next resend or a future edit, which is a one-time, harmless
inaccuracy (worst case: a teacher clicks Resend once for a contact that was
already reached, at the same address, with the same content). Not worth a
backfill migration for a display-only, self-correcting inaccuracy.

## `POST /api/students` — unconditional write, unchanged gate

Immediately after `inviteContact` returns `ok: true` (covering both the
create and the revive path — both already share the one call to
`deliverInvitation` below them), add a plain, unconditional update:

```ts
await prisma.invitation.update({
  where: { id: result.value.id },
  data: { lastNotifiedAt: new Date(), lastNotifiedEmail: parsed.data.email },
});
```

This is a fixed-cost extra query on every successful invite, identical
regardless of whether the address is blocked, registered, or a stranger — it
cannot become a new timing channel because every branch pays the same cost.

**The existing `if (result.value.delivered)` gate around
`deliverInvitation` is untouched.** Its docblock already documents it as one
of two independent guards (belt-and-braces with `notifyInvitee`'s own
re-check) — removing it to simplify this change would trade a documented,
reviewed defense-in-depth layer for a cosmetic convenience, which is not a
trade this fix needs to make.

`deliverInvitation` itself (teacher-name lookup + `notifyInvitee` call,
currently a local function in this route file) moves to
`src/services/invitations.ts` as an exported function — the new resend route
needs the identical dispatch, and "services are framework-agnostic, routes
are thin wrappers" is the existing house rule this was already violating by
living in a route file. This is a relocation, not a rewrite in substance,
but its signature gains an explicit `db: PrismaClient` first parameter
(dropping the module-level `prisma` singleton it currently closes over) to
match every other exported function in this file —
`inviteContact(db, input)`, `notifyInvitee(db, input)` — none of which reach
for the singleton themselves. Both call sites become
`deliverInvitation(prisma, teacherId, email)`. Everything else — the
docblock's oracle-safety reasoning, the fire-and-forget contract, the
`.catch` shape at each call site — carries over unchanged, with one added
sentence noting the route now has two callers instead of one.

## `POST /api/invitations/[id]/resend` (new route)

New file, sibling to `[id]/respond/route.ts`:

```ts
export const POST = withErrorHandler(async (request, { params }) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const limit = checkStudentWriteLimit(session.teacherId);
  if (!limit.allowed) {
    log.warn({ teacherId: session.teacherId }, 'invitation resend refused: rate limit exceeded');
    return respondRateLimited(limit); // see below
  }

  const invitation = await ownedInvitation(session.teacherId, id);
  if (!invitation) return NOT_FOUND();

  if (invitation.status === 'declined') return DECLINED();
  if (invitation.status !== 'pending') {
    return respondError('This invitation is no longer pending.', 409, 'NOT_PENDING');
  }

  await prisma.invitation.update({
    where: { id },
    data: { lastNotifiedAt: new Date(), lastNotifiedEmail: invitation.email },
  });

  void deliverInvitation(prisma, session.teacherId, invitation.email).catch((err) => {
    log.error({ err, teacherId: session.teacherId, invitationId: id }, 'failed to resend invitation');
  });

  return respondOk({ id });
});
```

- **Rate limit:** the exact same `checkStudentWriteLimit` bucket
  `POST /api/students` already uses, keyed on `teacherId`. Its own docblock
  already anticipates "an equivalent" being needed (issue's acceptance
  criterion 5); reusing the identical function is the direct reading of
  that sentence, not a new bucket to reconcile against it.
- **`accepted` status:** unreachable from the UI (the contact detail page
  redirects away from an accepted invitation) but reachable by a direct API
  call. 409s with a distinct, honest message rather than pretending the row
  doesn't exist.
- **No CAS on the status check.** A decline landing in the gap between the
  read and the write would let a stale send through — but `notifyInvitee`
  itself has never checked `Invitation.status`, only `TeacherBlock`, so this
  exact race already exists on the original `POST /api/students` path today
  (a decline landing between `inviteContact`'s creation and the
  already-scheduled fire-and-forget dispatch sends the same way). This spec
  doesn't newly introduce that gap or make it any wider; adding a CAS here
  would fix a pre-existing race as an uninvited side effect of an unrelated
  feature, which is out of scope.

### Shared helpers move out of `route.ts`, not into it

`ownedInvitation`, `NOT_FOUND`, and `DECLINED` currently live as
non-exported symbols in `src/app/api/invitations/[id]/route.ts`. Next.js's
Route Handler convention restricts what a `route.ts` file may export (HTTP
verbs plus a small fixed config allow-list), so the safe way to share them
with the new sub-route is a plain sibling module —
`src/app/api/invitations/[id]/shared.ts` — holding exactly these three,
exported, with `[id]/route.ts` and `[id]/resend/route.ts` both importing
from it. `ownedInvitation`'s `select` gains `email: true` (needed by resend,
harmless for its three existing callers, which already ignore extra
selected fields). `casMatchedNothing` stays local to `[id]/route.ts` — this
route's read-then-write has no CAS to explain a mismatch for (see above).

Its own docblock ("The ownership preamble shared by PUT/DELETE/PATCH
below") gets a fourth name added and a note that it now lives in `shared.ts`.

### A small, genuine dedup: `respondRateLimited`

`POST /api/students` and the new resend route now build the identical
429 body from the identical `checkStudentWriteLimit` result — same
`Math.ceil(retryAfterSeconds / 60)` pluralization, same message shape. A
small shared helper (`src/lib/rate-limit.ts`, beside `checkStudentWriteLimit`
itself) replaces both inline copies:

```ts
export function respondRateLimited(limit: RateLimitResult) {
  const minutes = Math.ceil(limit.retryAfterSeconds / 60);
  return respondError(
    `Too many invitations. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    429,
  );
}
```

(`respondError` import moves into `rate-limit.ts`. The `log.warn` call stays
at each call site rather than folding into the helper — the `teacherId`
field is identical, but the message text names the action
("invitation refused" vs. "invitation resend refused"), which matters for
grepping operator logs and isn't worth genericizing away.)

## UI

**`/students/contacts/[id]/page.tsx`** — add `lastNotifiedAt` and
`lastNotifiedEmail` to the existing `prisma.invitation.findFirst` select.
Directly under the existing status label, when `status === 'pending'`:

```tsx
<p className="type-caption">
  {invitation.lastNotifiedEmail === invitation.email
    ? `Last invited ${timeAgo(invitation.lastNotifiedAt!)}`
    : 'Not yet sent to this address'}
</p>
```

`timeAgo` (`src/lib/format.ts:17`) already exists for exactly this compact
voice ("5m ago", "3h ago") — reused, not reinvented.

**No change to the status label itself** (`STATUS_LABEL`, still "Invited"
for pending) — per the earlier discussion, delivery state and lifecycle
status are orthogonal, and this codebase already keeps orthogonal axes as
separate UI elements rather than one overloaded label (payment states are
their own text, never folded into a badge).

**New `ResendInvitationButton`** in `contact-form.tsx`, alongside
`ArchiveContactButton`, shown only when `status === 'pending'`. Same shape
as `ArchiveContactButton`: plain `type-caption` button, a `loading` state
that swaps its label ("Resend invitation" → "Sending..."), inline error
text on failure via `readErrorMessage`. On success: `router.refresh()` — no
separate toast or confirmation copy needed, since the refreshed
"Last invited just now" line on the same page *is* the confirmation.

## Comments to correct (Comment Discipline)

Every one of these currently states something that becomes false the moment
this ships — corrected, not annotated with "this used to say":

1. `src/services/invitations.ts:51-52` (inside `REFUSAL_MESSAGES`'s
   docblock) — rewrite to state the resend route now exists, and update
   `REFUSAL_MESSAGES.ALREADY_INVITED`'s copy itself to point there instead of
   at delete-and-recreate: `'You have already invited this person — open
   their contact to resend or update their details.'` (one sentence, per the
   docblock's own stated length constraint).
2. `src/app/api/students/route.ts:175-180` (inside the `.catch`) — the "there
   is no resend... do not grow one out of this catch" paragraph is rewritten:
   this catch still exists for the operator log line, but the teacher's own
   recovery is now the resend route, not delete-and-recreate.
3. `src/services/invitations.ts:341-345` (`notifyInvitee`'s docblock,
   the paragraph about `PUT` not notifying) — still true, needs one added
   sentence naming the new second caller (resend) and that it follows the
   same fire-and-forget, re-check-the-block contract as `POST /api/students`.
4. `src/lib/rate-limit.ts:191-205` (`checkStudentWriteLimit`'s docblock) —
   "There used to be a second caller... this is a single-caller budget
   again" becomes false; state resend as the new second caller, sharing the
   budget by design (issue's own acceptance criterion 5).
5. `ownedInvitation`'s docblock, once moved to `shared.ts` — name the fourth
   consumer and the new file location.

## Acceptance

1. `POST /api/invitations/[id]/resend` exists; `PUT` is unchanged.
2. The resend route's response status and latency do not vary with whether
   the address is registered, blocked, or unknown — verified the same way
   `POST /api/students` already is (mocked `notifyInvitee` internals aside,
   the route returns before the dispatch is awaited).
3. A blocked address's resend still writes `lastNotifiedAt`/
   `lastNotifiedEmail` and still creates no `Notification` row and sends no
   email — one test proves the marker is written, a second (mirroring
   `invitations.notify.test.ts`'s existing shape) proves nothing else
   happened.
4. The contact detail page shows "Not yet sent to this address" for a
   pending invitation whose `email` was edited since its last notify
   attempt, and "Last invited …" once resent.
5. `checkStudentWriteLimit`'s bucket is shared and exhausting it via resend
   calls also blocks a subsequent `POST /api/students` call for the same
   teacher (proves it's the same bucket, not a same-shaped second one).
6. `main` green — `npm run verify` plus the CI-only tiers (migration drift,
   build, Playwright) per the hazard list.

## Proving each guard bites (§3)

- **Remove the unconditional marker write from `POST /api/students`,
  leave it only inside the gated `deliverInvitation` branch** → a test that
  invites a blocked address and asserts `lastNotifiedAt` is still set must
  fail (this is the oracle-safety regression this spec exists to prevent).
- **Drop the resend route's status guard** → a test that resends a
  `declined` invitation must get a 409, not a 200 with a live send.
- **Drop the rate-limit check in the resend route** → a test that resends
  past the shared bucket's ceiling must get a 429, not a 200.

## Not doing

- No CAS on resend's status pre-check (above) — matches the original send
  path's existing tolerance for the same race, not a new gap.
- No backfill migration for pre-existing rows' `NULL` marker columns
  (above) — a one-time, self-correcting display inaccuracy, not a defect.
- No change to `PUT`'s behavior or its own docblock's reasoning about not
  notifying — still true, untouched.
- No new status value on `InvitationStatus` — delivery state stays two
  plain columns, not a lifecycle transition (matches `CalendarEntry`'s
  `cancelledAt` precedent, not a stored status).
