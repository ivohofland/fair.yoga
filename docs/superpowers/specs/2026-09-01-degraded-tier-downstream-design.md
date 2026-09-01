# A tier we had to substitute is a tier we do not know

**Date:** 2026-09-01
**Status:** Approved (issue #158; design agreed with Ivo — the whole
student-facing tier story rather than the two surfaces the issue names, no
user-visible message, no second log line at the overwrite, and no DDL in the
integration tier)

## Problem

`toIncomeTier` (`src/lib/tiers.server.ts`) substitutes `DEFAULT_INCOME_TIER`
when a stored tier is outside 1–5, so a public page renders rather than 500s.
#39 set that policy deliberately and gave the billing path a throwing variant
instead. What #158 asks is what the *display* side does once the substitution
has happened, and the answer is that three student-facing surfaces state, about
a specific signed-in person, something the code does not know.

Reaching the state needs the CHECK constraint bypassed — a `psql` session, a
restore from a pre-migration backup, a future migration mistake. That is the
case the fallback exists for.

## The premise, checked

### What held

**`PersonalPriceRange` asserts certainty from a possibly-substituted value.**
`(public)/[slug]/book/[classId]/page.tsx` gates on `viewer.tierSelectedAt` and
feeds `estimateAttendanceSpread` either the viewer's profile tier or their own
registration's `tierAtBooking`. The copy — "depending on how many join" — says
the tier question is settled.

**`TierForm` can erase the row with a no-op save.** `useState(currentTier)` is
seeded with the substituted 3, Save PUTs unconditionally with no dirty check,
and `PUT /api/students/[id]` writes it (and stamps `tierSelectedAt` alongside).

**It is genuinely unreachable through the app.** Both CHECK constraints exist
(`20260802150845_income_tier_range_check`), and `updateStudentSchema.incomeTier`
refines through `isIncomeTier`, so the only client-supplied tier is bounded
before it reaches Prisma.

### What was wrong or incomplete

**A — "the raw stored value is the one artifact" overstates it.**
`toIncomeTier` logs `{ tier, ...context }` on *every read*, and `/account/tier`
must render — and therefore warn, with `studentId` — before the Save button
exists. So the raw value is already on disk in the log before any student can
destroy it. What the no-op save destroys is the *durable* artifact, not the only
one. The only overwrite with no preceding warn is a direct API call, which is
not "a student taking an entirely reasonable action". The fix is still worth
making, for a different reason than the issue gives: it turns an accidental
overwrite into a deliberate one.

**B — a third surface asserts the same false certainty, on the same page.**
`BookingFlow`'s returning-student branch renders **"You're in Tier 3 ·
Comfortable"** from `currentTier={viewer.tier}`. That names the tier outright, a
stronger claim than the price line hedged one paragraph above it. The issue
names only `PersonalPriceRange`.

**C — a corrupt `Student.incomeTier` does not merely misprice; booking cannot
succeed.** `api/registrations/route.ts:185` writes `tierAtBooking:
student.incomeTier` raw, and so do both waitlist promotion paths
(`services/waitlist.ts:545,670`). `Registration_tier_at_booking_check` rejects
it. The student is shown a confident price for an action that cannot complete.

**D — the two corruptible columns give different symptoms, and the issue
conflates them.**

| Corrupt column | Viewer state | What the price line shows | Other damage |
|---|---|---|---|
| `Student.incomeTier` | not booked | wrong — quoted from tier 3 | booking 500s (C) |
| `Student.incomeTier` | already booked | **correct** — quoted from the registration row | "You're in Tier 3" is false (B) |
| own `Registration.tierAtBooking` | already booked | wrong | `completeClass` throws, by #39's design |

The already-booked row is the one to keep in view: the profile tier does not
reach the price line at all there, so a design that suppressed the personal line
on any degraded read would suppress a correct quote.

**E — `BookingFlow` has no erasure problem.** It guards `if (tier !==
currentTier)` before PUTting, so accepting the shown default writes nothing.
`TierForm` is the only accidental-overwrite path — which the issue implies but
does not establish.

**F — the degraded state is testable, and we are deliberately not testing it
that way.** `class-lifecycle-tier-guard.test.ts` establishes the pattern (drop
the constraint with raw SQL, corrupt the row, assert, restore in `finally`), and
integration tests already assert SSR page HTML (`waitlist-display.test.ts`). But
`ALTER TABLE … DROP CONSTRAINT` takes ACCESS EXCLUSIVE on the table, which is
exactly why `vitest.config.ts` lists that file in `LOCK_CONTENTION_TESTS`; CI
runs `npx vitest run --project integration --file-parallelism` (`ci.yml:263`),
and `Student` is a hotter table than `Registration`. See §Testing.

## Design

### 1. One reader, two answers

`src/lib/tiers.server.ts` gains a sibling, and `toIncomeTier` is redefined in
terms of it so there is a single logging site:

```ts
export function readIncomeTier(n: number, context?: Record<string, string>): IncomeTier | null {
  if (isIncomeTier(n)) return n;
  log.warn({ tier: n, ...context }, 'income tier outside 1-5; DB constraint bypassed');
  return null;
}

export function toIncomeTier(n: number, context?: Record<string, string>): IncomeTier {
  return readIncomeTier(n, context) ?? DEFAULT_INCOME_TIER;
}
```

`toIncomeTier`'s observable behaviour is unchanged: same return, same warning,
same payload. Every existing call site stays as it is.

**Which one a caller wants is a question about whose tier it is.** A tier the UI
will speak about as *this person's* is read with `readIncomeTier`, and `null`
means the surface must not make a claim about it. A tier entering an aggregate
over other people — the pool of registrations behind an estimate — keeps
`toIncomeTier`: there is no honest per-person UI for "one of the other
attendees' rows is corrupt", and one substituted ratio only nudges a shared
price. The docblock states that rule; per *Comment Discipline* it does not list
which call sites are on which side, because that list has no owner.

### 2. The booking page

`viewer.tier` becomes `IncomeTier | null`, and the tier the personal line would
quote is computed once, before the JSX, from the same branch the current code
inlines:

```ts
// A booked viewer is billed at the tier stamped on their registration;
// anyone else would join at their profile tier. Either can be unreadable,
// and the personal line may not speak for a tier we had to substitute.
const quotedTier = viewer
  ? alreadyBooked && ownRegistration
    ? readIncomeTier(ownRegistration.tierAtBooking, { registrationId: ownRegistration.id })
    : viewer.tier
  : null;
```

The line then renders as `viewer && viewer.tierSelectedAt && quotedTier !== null
? <PersonalPriceRange …> : <PriceRange …>`. The anonymous fallback's copy —
"depending on your income tier" — is true in exactly the state that triggers it,
which is why no new copy is needed.

Row D falls out for free: an already-booked viewer with a valid registration row
still gets `PersonalPriceRange`, correctly, even when their profile tier is
corrupt.

**The compiler holds this one.** `estimateAttendanceSpread` requires
`viewerTier: IncomeTier` (`lib/tier-estimates.ts`), so once `readIncomeTier`
returns a nullable, the null branch cannot be deleted and still build. That is a
tether rather than a comment promising a check.

### 3. `BookingFlow`

`currentTier` becomes `IncomeTier | null` and `tier` becomes
`useState<IncomeTier | null>(currentTier)`.

The picker branch is chosen by `isFirstBooking || currentTier === null`, written
inline as the ternary condition rather than lifted into a `const`, so TypeScript
narrows `currentTier` to `IncomeTier` in the summary branch. The summary reads
`currentTier` rather than `tier`; the two are identical there because the picker
is the only thing that calls `setTier`, and only `currentTier` narrows.

Book and Join-the-waitlist are disabled while `tier === null`, and the button's
price suffix is dropped in that state (`Book`, not `Book — around €…`).
Disabling the waitlist button matters as much as the booking one: promotion
writes `tierAtBooking: student.incomeTier` raw too.

This is what removes C. The existing `if (tier !== currentTier)` guard fires for
any selection once `currentTier` is `null`, so the PUT lands before the
registration POST and the row is repaired on the way through.

### 4. `TierForm` and the tier page

`currentTier` becomes `IncomeTier | null`; nothing is pre-selected when it is
null (`aria-checked={tier === t.tier}` already gives this), Save is disabled
until a tier is chosen, and `handleSave` returns early on `null` so the
`TierBody` payload keeps its `IncomeTier`. `account/tier/page.tsx` calls
`readIncomeTier` instead of `toIncomeTier`.

No message, no explanation, no new copy. The absence of a selection is the
honest signal: it leaks no internals, alarms nobody about a thing they cannot
fix, and a picker with nothing chosen is simply not a lie. The student picks,
saves, and the row is repaired by an act that was theirs.

### 5. What this deliberately does not do

**No second log line at the overwrite.** A read-before-update in
`PUT /api/students/[id]` would warn at the moment of destruction, but the read
side already logged the raw value with the same `studentId` seconds earlier —
the page had to render for the button to exist. The marginal information is a
timestamp, bought with a database read on every tier save. **#157** is the issue
that makes any of these warnings observable; this one does not duplicate them.

**No change to the registration or waitlist write paths.** They pass
`student.incomeTier` through raw, and should: substituting a tier onto a
`Registration` is precisely the silent mis-charge #39 refused. Failing loudly is
what the constraint is for. Once §3 lands, a student whose profile is corrupt
repairs it before the write, so the loud failure stops being the path they take.

**No user-visible signal.** Considered and declined at the design gate — see §4.

## Testing

Three tiers, no database DDL. The state under test is unreachable through the
app, so the thing that can regress is the *decision*, and every mutation that
could undo it is caught below.

**`src/lib/tiers.server.test.ts` (unit)** — `readIncomeTier` returns the tier
for 1–5 and `null` outside it, warns once, and merges its `context` into the
payload; `toIncomeTier` still returns `DEFAULT_INCOME_TIER` and still warns, so
the refactor's behavioural neutrality is pinned rather than assumed.

**`src/components/student/tier-form.test.tsx` (components)** — with
`currentTier={null}`: no radio is checked, Save is disabled, and clicking it
sends nothing. Picking a tier enables Save and sends that tier. The existing
key-set pins stay.

**`src/components/booking/booking-flow.test.tsx` (components, new)** — with
`currentTier={null}` and `isFirstBooking={false}`: the picker renders and no
"You're in Tier" text appears; Book is disabled; picking a tier PUTs the tier
*before* POSTing the registration (assert the call order — that ordering is what
repairs the row). With a known tier left unchanged: no PUT, which pins the
existing guard that keeps `BookingFlow` off the erasure path (finding E).

`fetch` is not mocked in the components project — each test that clicks stubs it
with `vi.stubGlobal('fetch', …)` (`vitest.config.ts`'s note on that project).

### Guards must be proved to bite

Per §3 of the solve-issue skill, each mutation below is applied, the exact
failure text recorded, and the mutation reverted:

1. `readIncomeTier` returns `DEFAULT_INCOME_TIER` instead of `null` — the unit
   file goes red. **Not** the component files: they pass `currentTier={null}`
   as a prop and never call the reader, so a mutation there could not fail
   them. Recording that here rather than discovering it during the run.
2. The page's `quotedTier !== null` condition removed — must fail to compile
   (`estimateAttendanceSpread` demands `IncomeTier`); the error text is the
   record.
3. `disabled={… || tier === null}` removed from `TierForm` — component red.
4. `|| currentTier === null` removed from `BookingFlow`'s picker condition —
   component red.
5. The PUT-before-POST order in `BookingFlow` swapped — component red.

Corruption values in tests use `0` and `9`, outside anything the code can
produce.

### The one mutation nothing catches

Reverting either page's `readIncomeTier` call to `toIncomeTier` compiles,
lints, and passes every test above: `quotedTier` becomes non-nullable, the
`!== null` comparison stays legal (TypeScript special-cases `null`), and the
personal line renders again from a substituted value. The lint rule that would
see it, `@typescript-eslint/no-unnecessary-condition`, is not enabled and needs
type-aware linting the Next config does not set up — turning it on repo-wide is
its own change with its own fallout, and is not this issue's.

Its home is therefore a comment, one line, beside each of the two calls, saying
why the nullable reader is the one this call site needs. That is a claim about
the code it sits on, so it is a comment this project allows.

## Artifacts to correct

- `docs/backlog-roadmap.md:1126` — the live backlog entry for #158 repeats
  claim A ("erases the only evidence"). Mark it closed in the file's existing
  convention and carry the correction. The retrospective at ~2160 records what
  was believed when #158 was spun out and stays as history.
- `src/lib/tiers.server.ts` — `toIncomeTier`'s docblock currently names two
  specific pages and a specific `.map` call in another module. It has to be
  rewritten anyway to describe the split, and the replacement states the rule
  without the roster (*Comment Discipline*).
- The GitHub issue's acceptance criteria are both met; findings A–F belong in
  the PR body.
