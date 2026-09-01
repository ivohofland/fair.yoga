# A new teacher has no way in — issue 385

`POST /api/teachers` is a complete, unauthenticated, rate-limited, race-safe
signup endpoint that nothing in `src/` calls. There is no `/signup` page, and
`/` belongs to the `(teacher)` route group, so a first-time visitor is bounced
to a sign-in form that cannot create anything. A person who wants to teach on
fair.yoga cannot become a teacher through the running app.

This spec builds the way in, and reconciles the onboarding checklist that
already exists with the four-step flow the docs describe.

---

## The gap, re-verified against current main

Every claim in #385 holds. Measured 2026-09-01 on
`worktree-velvety-bouncing-umbrella` at `c7bf4c1c`:

| Claim | Verified at |
|---|---|
| The route is built, unauth, IP-limited 3/hr, race-safe | `src/app/api/teachers/route.ts:10-91` |
| Nothing in `src/` calls it | Only hits are `PUT /api/teachers/${teacherId}` (`components/settings/profile-form.tsx:106`) and two comments (`lib/unique-conflict.ts:25`, `lib/format.ts:201`). Only `tests/` POSTs |
| No `/signup` or `/join` page | 43 `page.tsx` files = 4 `(public)` + 7 `(student)` + 32 `(teacher)`; none is a signup page. `find src/app -name 'page.tsx' \| wc -l` |
| No `/` for a logged-out visitor | `/` resolves to `(teacher)/page.tsx`; `(teacher)/layout.tsx:17-23` redirects a session-less visitor to `/login` |
| `/login` is sign-in only, silent on unknown emails | `api/auth/magic-link/send/route.ts:41-52` |
| The student side has the equivalent built | `api/auth/student-signup/route.ts` + `components/booking/booking-sign-in.tsx` |

### Four things the issue does not say

**1. The teacher route is not the student route's equivalent.**
`student-signup` mints the account **and sends the magic link** in one request
(`student-signup/route.ts:107-109`). `POST /api/teachers` returns 201 and sends
nothing. A page that merely called it would leave the new teacher created and
signed out, with nothing in their inbox — and invisible to `/login` forever,
because `magic-link/send:41-42` looks up Teacher-then-Student and never
`Account`, so it cannot mint a second link for a half-finished signup.

**2. The route's field set contradicts the documented signup screen.**
`createTeacherSchema` (`lib/schemas.ts:162-172`) requires all five of
`firstName`, `lastName`, `email`, `bio`, `pageSlug` in one body.
`teacher-screens.md` 1.1 specifies signup as "Enter email address", deferring
name and bio to 1.2 Profile Setup. Both cannot be true; this spec resolves it
in favour of the docs.

**3. The onboarding flow already exists, in a divergent form.**
`components/schedule/getting-started.tsx`, mounted at `(teacher)/page.tsx:81-87`
behind `roomCount === 0 || classCount === 0` (line 67), ships **bank details →
room → class**. The documented flow (`teacher-screens.md` 1.3,
`information-architecture.md:232-236`, `product-concept.md:24`) is
**① Profile ② Room ③ Class ④ Share**. Room and Class agree; Profile and Share
are absent; bank details is an unplanned addition. This is a reconciliation,
not a greenfield build.

**4. A public `/` collides with the teacher home at `/`.**
Route groups do not create URL segments, so `(public)/page.tsx` and
`(teacher)/page.tsx` both resolve to `/` and the build refuses. Note
`(teacher)/schedule/page.tsx:5` currently exists *only* to redirect to `/`.

### Two live defects found in passing

- **`'signup'` is not in `RESERVED_SLUGS`.** `lib/schemas.ts:157-160` lists 14
  reserved names and does not include it, so a teacher can claim
  `fair.yoga/signup` today and be silently shadowed by the new static route
  (a static segment beats the `[slug]` dynamic one).
- **`?redirect=` is dropped at `/login`.** `proxy.ts:11-13` stamps it;
  `(public)/login/page.tsx` never reads it and posts `{ email }` alone — even
  though `magic-link/send` accepts `redirect` and `(public)/verify/page.tsx`
  carries `destinationCopy()` written for it. Every deep-link bounce lands on
  the role default. **Not fixed here** — filed, see *Not doing*.

---

## Decision 1: nothing exists until the inbox is proven

`/signup` takes an email address and creates **no rows**. It mints a
`MagicLinkToken` marked `teacher_signup`. Verification reads that marker,
creates the `Account`, opens a session, and lands the person on
`/signup/profile`, where the `Teacher` row is created from an **authenticated**
request.

This is the rule `api/account/student-profile/route.ts:15-18` already states
and that `POST /api/teachers` is, on current main, the sole violator of — a
violation Decision 6 resolves by deleting the route:

> Profile attachment happens only here — from an authenticated session, never
> from an unauthenticated signup route.

It also closes #382's squatting vector: there is no row to squat before someone
has proved they control the address. Combined with Decision 6, which deletes the
offending route outright, **this PR closes #382** — see that section for why
that is a resolution and not a presumption.

**Why a stored marker rather than inference.** "A token verifies but no account
resolves" is unreachable on current main — `magic-link/send` only mints for
known users, and `student-signup` creates its `Student` before minting. Teacher
signup makes that state reachable for the first time. Inferring intent from it
would rest on a census of who mints tokens staying true across files, which
CLAUDE.md's *Comment Discipline* names as the claim shape with no owner: a
fourth minting route added later would silently inherit teacher-signup
behaviour. The marker is explicit and compiler-tethered.

## Decision 2: the landing page takes `/`, the teacher home moves to `/schedule`

`(teacher)/page.tsx` moves to `(teacher)/schedule/page.tsx`, replacing the
redirect that lives there now. `/` becomes a public landing page that redirects
a signed-in teacher to `/schedule` and a signed-in student to `/bookings`.

`fair.yoga` is then the product's front door, which is the correct arrangement
for a public open-source product people will link to, and doing it before any
external links exist is cheaper than doing it after.

**This reverses a documented decision** — CLAUDE.md's *Information
Architecture* ("the Schedule tab at `/` is the home base (`/schedule` redirects
there)") and `information-architecture.md`. Both are updated in this PR.

**The migration is fail-safe by construction.** Because the new `/` redirects a
signed-in teacher to `/schedule`, every `redirect('/')` left unconverted still
lands correctly, at the cost of one extra hop. Nothing breaks silently. The one
place a miss is user-visible is `components/layout/page-header.tsx:17`'s
`backHref = '/'` default, where the hop would show on every back navigation.

`docs/implementation-plan.md:281` ("7.10 — Landing page / marketing page")
covers the landing page's **copy and design**, and is filed separately; this PR
builds the route and a plain, honest page. See *Not doing*.

## Decision 3: setup asks for the address, the checklist asks for the rest

`/signup/profile` collects name (empty, typed), page address (derived live from
the name, client-side) and a **skippable** bio with the 250-character live count
`teacher-screens.md` 1.2 describes.

The page address is required because it is the one field that cannot be
defaulted: it is `@unique`, it is the public URL, and a machine-picked value the
teacher later changes breaks every link they have already shared.

The bio is optional because that is what makes documented step ① Profile a
*real* step. Had setup required a bio, the checklist's Profile row would arrive
permanently checked — a step that can never be actioned. `bio` is
`String @db.VarChar(250)`: non-nullable, so there is no `null` to mean "unset",
but `''` is a value the column already accepts. `teacherProfileSchema` types it
`z.string().max(250)` with no `min`, matching what the deleted
`createTeacherSchema` did — so "no bio yet" needs no migration and no sentinel,
and `bio !== ''` is a done-condition read straight off an existing column.

Documented step ④ Share becomes the checklist's **completion state** rather than
a row, because nothing in the schema can record "this teacher shared their
page" and `teacher-screens.md` 1.3's "Disappears once all steps are complete" is
therefore unimplementable for it as written.

## Decision 4: optional steps get a Skip control, and that is what makes them optional

No "Optional" label. The presence of a Skip button *is* the marker.

This is not only cosmetic: it gives optional steps a **terminal state**, which
is what the current design lacks. `(teacher)/page.tsx:63-67` retires the card on
the two required steps and says why:

> `// Bank details are optional (cash-only teachers exist) — the card retires`
> `// on the two required steps, or it would pin itself forever.`

Once a step can be skipped it can finish, so the card retires honestly when
**every** step is done or skipped — and the ordering problem disappears. Under
the current gate, a teacher who adds a room and a class first loses the profile
and bank prompts without ever having chosen. Under this one they either did
them or said no.

Required steps (room, class) are **not** skippable. They are the path to
teaching, which is the card's entire purpose; a card clearable on day one with
nothing done would not be worth having.

## Decision 5: the page address is checked live, and the check is advisory

A debounced availability check shows `✓ Available` or `✕ That address is taken`.
No suggestions and no auto-numbering.

**Not auto-numbering** because the slug is the teacher's public identity — the
string they put on a flyer. Silently handing someone `anna-devries-2` because a
stranger registered first decides something about their own name on their
behalf, and they may not notice until it is printed. It also retires nothing:
two callers can submit at the same instant, so `SLUG_TAKEN` must be handled
regardless.

**No suggestions** because generating them adds a surface to get subtly wrong
(a suggestion already taken by the time it is tapped) for a problem retyping
solves.

**Availability is public information already.** `(public)/[slug]/page.tsx:40`
calls `notFound()` for an unknown slug, so anyone can probe `fair.yoga/anything`
today and learn exactly what this endpoint reports. It discloses nothing new,
and needs IP rate-limiting only so it is not *cheaper* than probing. This is the
opposite of **email**, where `student-signup` and `magic-link/send` both return
uniform 200s precisely to prevent enumeration. The two must not be reasoned
about together.

**The check is advisory; the 409 is the guard.** There is always a gap between
"available" and submit — the same reasoning `api/teachers/route.ts:44-48`
already records about its own pre-checks.

**Erasure frees slugs**, so "available" is honest: `services/gdpr.ts:1457`
rewrites an erased teacher's slug to `deleted-<teacherId>`.

**Reserved names need no request.** `lib/schemas.ts` is already imported by 14
`'use client'` components, so the rule runs in the browser. `RESERVED_SLUGS` is
module-private today; this extracts a shared `pageSlugField` validator consumed
by `createTeacherSchema`, `updateTeacherSchema` and the client, so the form
cannot drift from what the server accepts.

**Derivation must degrade, not block.** `pageSlugField`'s regex is
`/^[a-z0-9-]+$/`, so a name in a non-Latin script derives to the empty string.
The field is then left empty for the teacher to fill. It must never block
submission or emit a placeholder slug — CLAUDE.md's *Key Constraints* commit to
international from day one.

## Decision 6: `POST /api/teachers` is deleted, and that closes #382

The route is removed, not left dead. Leaving a live, unauthenticated,
account-creating endpoint in the codebase with a known security gap and nothing
in the UI pointing at it is worse than either using it or removing it — an
attacker does not need a link to find a route, and "another issue governs it" is
not a control.

**This resolves #382 rather than presuming its answer.** #382 declined to pick
between "confirm the address before creating the row" and "create then gate
first use", because that was a product call. This spec makes that call: nothing
is created before confirmation, and the route that created things without it is
gone. Both consequences #382 names are answered:

- *Squatting/blocking* — there is no unauthenticated write left to squat with.
- *Unclaimed-student shadowing* — the new path runs through
  `resolveOrClaimAccount`, so an unclaimed CRM row under that address is
  **claimed** at verification and the teacher profile is then added to that same
  account. One account, both hats — which is the behaviour
  `api/account/student-profile/route.ts` already implements for the mirror case,
  and strictly better than the shadowing the old route's own comment described.

The PR body says `Closes #382` deliberately.

### What the deletion invalidates

Swept by grepping the names being removed, not the call sites being changed
(`solve-issue` §4). Every hit gets a verdict; legitimate survivors are expected.

| Site | Verdict |
|---|---|
| `src/app/api/teachers/route.ts` | Deleted — the file holds `POST` and nothing else. `api/teachers/[id]/route.ts` keeps `GET` and `PUT`, untouched |
| `lib/schemas.ts:162-172` `createTeacherSchema` | Deleted; replaced by `teacherProfileSchema`, which carries **no** email — it comes from the session |
| `src/lib/schemas.test.ts:615-624` | **Roster assertion**, "covers exactly the six schemas that carry an address", listing `createTeacherSchema`. Drops to five. The count moves out of the test *name*: the array below it is the tripwire, and a number in prose beside it is a second claim that rots independently |
| `lib/rate-limit.ts:43`, `:51`, `:250` `'teacher-signup'` | **Survives.** The new `POST /api/auth/teacher-signup` reuses the prefix, so `IpRateLimitPrefix` and `PREFIX_CAPACITIES` are unchanged and `rate-limit.test.ts`'s five call sites keep working |
| `lib/unique-conflict.ts:25` | Names `/api/teachers` as creating `Teacher` and `Account` together. Now false — retargeted at `teacher-profile` |
| `lib/format.ts:201` | Says `POST /api/teachers` hardcodes `Europe/Amsterdam`. Now false — the new route does. Retargeted |
| `docs/technical-architecture.md:32` | Live reference doc describing the route's rate-limit coverage, including a dedicated test proving its IP check degrades to a shared bucket when both headers are absent. Rewritten against the new route |
| `docs/implementation-plan.md:97` | **Survives** — `api/teachers/*` still covers profile and settings via the `[id]` route |
| `docs/superpowers/specs/2026-07-20`, `2026-08-07` ×2, `2026-08-11`, `2026-08-18`, `2026-09-01-raced-create` | **Survive unedited.** Dated design records of work as it was done, not live reference. Rewriting them would falsify the history rather than correct a claim |

### Two test blocks are ported, not deleted

Both encode contracts that outlive the route:

- `tests/integration/signup-api.test.ts:63` — `POST /api/teachers`, including the
  no-`x-forwarded-for`/no-`x-real-ip` case proving the IP check degrades rather
  than skips. That is coverage of `checkIpRateLimit`, not of this route.
- `tests/integration/teachers-api.test.ts:159` — "keeps its conflict codes apart
  under a race (#161)". The new `teacher-profile` route has the same
  `SLUG_TAKEN` race and needs the same guarantee.

Deleting either would drop coverage the deletion did not make irrelevant —
the failure mode where an extraction quietly loses what the tests could not see.

---

## Data model

```prisma
enum OnboardingStep {
  profile
  bank
  share
}

enum MagicLinkPurpose {
  sign_in
  teacher_signup
}

model Teacher {
  // ...
  skippedOnboarding OnboardingStep[] @default([])
}

model MagicLinkToken {
  // ...
  purpose MagicLinkPurpose @default(sign_in)
}
```

**Enums, not booleans**, so step membership is compiler-tethered per CLAUDE.md's
*Comment Discipline*: an exhaustive `switch` with a `never` default catches an
unhandled step, where a prose roster of steps in a docblock would rot. The step
keys are named by the type; nothing in a comment counts them.

**`skippedOnboarding` is a scalar enum list, which this schema has no precedent
for** — the nearest thing is `Room.equipment Json @default("[]")`
(`schema.prisma:277`). The enum array is chosen over `Json` for type safety and
over a join table because the value is read on every render of the teacher home
and holds at most three members. Recorded here because it is a new pattern and a
reviewer should weigh it deliberately rather than assume precedent.

**`purpose` defaults to `sign_in`**, so every existing `MagicLinkToken` row and
the entire student flow are untouched by the migration. `student_signup` is a
one-member addition when the student side is ported (see *Not doing*).

Migration is generated with `npx prisma migrate dev --name teacher_signup_onboarding`.
No hand-authored CHECK constraint is required.

---

## `POST /api/auth/teacher-signup` (new)

Unauthenticated. Body: `{ email }` only.

1. IP rate limit — a new `RateLimitPrefix` member; the route can trigger a real
   email send, so it throttles before parsing, matching `magic-link/send:26-28`.
2. Per-email rate limit, its own bucket.
3. Mint `MagicLinkToken { purpose: teacher_signup, redirectTo: '/signup/profile' }`.
4. Send the link.
5. Return a **uniform 200** regardless of whether the address already has an
   account, a teacher, or nothing — same non-enumeration contract as
   `student-signup:111`.

**Re-runnable by design.** A person who signs up and loses the email has no
other way back: `magic-link/send:41-42` looks up Teacher-then-Student and never
`Account`, so a half-finished teacher is invisible to `/login`. Re-submitting
`/signup` mints a fresh token. `magic-link/send` additionally learns about
profile-less accounts so `/login` stops being a dead end for them.

**An address that already has a complete teacher** gets an ordinary sign-in
link, not a signup one — the marker is only set when no teacher profile exists
for that address. This keeps the uniform 200 honest without letting a stranger
push an existing teacher down the signup path.

## `POST /api/auth/magic-link/verify` — a third branch

Currently `verify/route.ts:33`:

```ts
const fallback = resolved.teacherId ? '/' : '/bookings';
```

Two changes. `'/'` becomes `'/schedule'` (Decision 2), and a resolved account
with **neither** profile falls back to `/signup/profile` rather than
`/bookings`, where `(student)/layout.tsx:13-15` has nothing for it.

When the token carries `teacher_signup` and no account resolves,
`resolveOrClaimAccount` returning `null` is no longer an error: the account is
created, the session opened, and the destination is `/signup/profile`.

`api/auth/passkey/authenticate/verify/route.ts:56` carries the identical
`teacherId ? '/' : '/bookings'` fallback and takes the same two changes.

## `POST /api/account/teacher-profile` (new)

Authenticated, sibling to `api/account/student-profile/route.ts`, and modelled
on it closely enough that the reasoning in its comments transfers.

Body: `{ firstName, lastName, bio, pageSlug }`.

- `409 ALREADY_TEACHER` when the session already has a teacher profile — the
  pre-check is a plain read, so a double-submit loses on `Teacher.accountId` or
  `Teacher.email` and is answered with the pre-check's own code, per #161.
- `409 SLUG_TAKEN` on `pageSlug`, matching `api/teachers/route.ts:74-76`.
- An unrecognised P2002 is logged at `error` and rethrown as an ordinary error,
  never as a P2002 — `classifyApiError` would answer a code-less 409, which is
  the defect that catch exists to remove.

**Naming the collision is not an enumeration oracle here**, for the reason
`student-profile/route.ts:70-75` records: the route is authenticated and writes
for the caller's own account, and `Account.email @unique` means no other account
holds this address.

## `GET /api/teachers/slug-available?slug=…` (new)

Unauthenticated, IP rate-limited, returns `{ available: boolean }`. Validates
against the shared `pageSlugField` first and answers `available: false` for a
reserved or malformed value without touching the database.

Discloses nothing `(public)/[slug]/page.tsx` does not already disclose (Decision
5). Advisory only.

---

## The root swap

19 source files carry a "`/` means the teacher home" reference (21 sites).
Re-derive with:

```bash
grep -rn "redirect('/')\|: '/'\|href=\"/\"" src/ | grep -v "'/api"
```

The largest group is eight student-side guards reading exactly
`redirect(session?.teacherId ? '/' : '/login')` — `(student)/layout.tsx:14`,
`updates/page.tsx:15`, `bookings/page.tsx:23`, `account/page.tsx:20`,
`account/privacy/page.tsx:27`, `account/data/page.tsx:11`,
`account/notifications/page.tsx:12`, `account/tier/page.tsx:13`. Identical text
in eight files is the shape CLAUDE.md's *Comment Discipline* and
`solve-issue` §4 both warn about, so this collapses them into one helper while
every one of them is being touched anyway. The helper also gains the
profile-less third branch, so all eight get it at once rather than seven of
them getting it and one being missed.

Also converted: `(public)/verify/page.tsx:115` and `:262`,
`api/auth/magic-link/verify/route.ts:33`,
`api/auth/passkey/authenticate/verify/route.ts:56`,
`(teacher)/class/[id]/page.tsx:73`, `(teacher)/class/[id]/edit/page.tsx:23`,
`(teacher)/studio-class/[id]/page.tsx:37`,
`(teacher)/studio-class/[id]/edit/page.tsx:24`,
`components/layout/tab-bar.tsx:8` and `:14`,
`components/layout/page-header.tsx:17`, `(student)/account/page.tsx:49`,
`app/not-found.tsx:9`, and `lib/session.ts:17` (`requireTeacherSession`, which
gains the profile-less branch).

E2E: 7 `goto('/')` sites across 5 files — `a11y.spec.ts:184`,
`studio.spec.ts:198` and `:497`, `recurring.spec.ts:157` and `:189`,
`teacher-journey.spec.ts:300`, `visual.spec.ts:367`.

`visual.spec.ts:367` produces the `schedule-*.png` snapshots. Moving the same
content to a new URL should not move pixels, but this worktree cannot run
Playwright to prove it — CI is the signal.

---

## The checklist

```
Getting started
  ○ Complete your profile      [ Skip ]     done: bio !== ''
  ○ Add your bank details      [ Skip ]     done: bankIban != null
  ○ Add a room                             done: roomCount > 0
  ○ Create your first class                done: classCount > 0
        ↓ every step done or skipped
  Your page is ready
  fair.yoga/anna-devries       [ Share ]    [ Dismiss ]
        ↓ share dismissed
  (retired)
```

Order per the teacher's call: profile before bank.

**Row markup changes.** `getting-started.tsx:52-71` wraps each entire row —
chevron included — in a `<Link>`. A `<button>` nested inside an `<a>` is invalid
interactive content and a real screen-reader defect, so each row becomes a
container holding a link and a sibling button. Skip buttons carry a per-step
accessible label ("Skip adding your bank details"); "Skip" alone is meaningless
out of row context.

**The share state reuses `components/class/share-booking-link.tsx`**, which
already handles the native share sheet, the clipboard, and the
clipboard-blocked fallback that shows the URL for manual copying. It does not
grow a second copy button.

**Retirement** is now "every step done or skipped", replacing
`(teacher)/page.tsx:67`'s `roomCount === 0 || classCount === 0`. The comment at
`:63-67` explaining why the gate could not include bank details is deleted, not
annotated — the constraint it describes no longer exists (`solve-issue` §4:
correct a claim by replacing it).

---

## Build order (load-bearing)

1. **Migration and the shared `pageSlugField`** — both enums and the extracted
   validator. Everything downstream types against them.
2. **The three routes** — `teacher-signup`, `teacher-profile`, `slug-available`,
   plus the `verify` third branch on both magic-link and passkey. Testable over
   HTTP with no UI.
3. **Delete `POST /api/teachers`** — after step 2, so the two ported test blocks
   move onto live replacements rather than being deleted and rewritten. Carries
   the `createTeacherSchema` removal and the `schemas.test.ts` roster edit with
   it, so the suite is never knowingly red between steps.
4. **The root swap** — before the landing page, so the landing page is written
   into a `/` that is already free rather than moved into it afterwards.
5. **The pages** — landing, `/signup`, `/signup/profile`, and the `/login` link.
6. **The checklist rework** — last, because its share state needs a real
   `pageSlug` from a teacher created by the flow above.

Two orderings are load-bearing: **4 before 5**, so the landing page is written
into a free `/`; and **2 before 3**, so the ported tests land on live
replacements and the suite is never knowingly red between steps. The rest is
convenience.

---

## Comments to correct (Comment Discipline)

- `(teacher)/page.tsx:63-67` — the retirement rationale, now false. Deleted.
- `api/teachers/route.ts:11-16` and `:27-33` — the two paragraphs deferring
  email-ownership verification and describing the unclaimed-student shadowing
  edge. **Deleted with the file**, not corrected: Decision 6 removes the route
  those comments annotate, and the gap they describe no longer exists.
- `lib/auth/magic-link.ts:13-33` — its docblock counts live tokens per address
  ("one address can hold six live tokens in a window, not three") from a census
  of minting routes. This PR adds a third minting route and falsifies it. The
  count is replaced with a statement of the invariant, not refreshed with a
  bigger number.
- `(public)/[slug]/page.tsx:18-20` — calls the public teacher page "the front
  door of the whole product". After this PR `/` is. Corrected in place.

---

## Acceptance

1. A person with no account reaches `/`, learns what fair.yoga is, and can get
   from there to a published first class without leaving the app.
2. `/signup` creates no database rows. Verified by row counts either side.
3. A `teacher_signup` token that is never clicked leaves nothing behind but the
   token, which `cleanupExpiredAuth` sweeps.
4. A teacher who loses the signup email can re-run `/signup` and get another.
5. A signed-in account with no profile lands on `/signup/profile` from every
   door: magic-link verify, passkey verify, both layouts, and
   `requireTeacherSession`.
6. The page address field reports availability live, rejects reserved names
   without a request, and leaves itself empty rather than blocking when a name
   derives to nothing.
7. Submitting a slug taken between check and submit answers `SLUG_TAKEN` and
   renders inline against that field.
8. The checklist retires only when every step is done or skipped, and the share
   state is the last thing seen before it retires.
9. `/` is reachable by a logged-out visitor, `/schedule` by a signed-in teacher,
   and every unconverted `redirect('/')` still lands correctly.

---

## Proving each guard bites (§3)

Each is broken deliberately, its exact error text recorded, restored, and
re-verified. Routes are curled once after each mutation before the verdict is
read — `next dev` compiles lazily and a first-request timeout reads exactly like
an assertion failure.

| Guard | Mutation | Must fail with |
|---|---|---|
| `purpose` marker | Mint the signup token as `sign_in` | Verify 400s; no `Account` created |
| `ALREADY_TEACHER` | Drop the `session.teacherId` pre-check | Second submit 409s on the unique key, same code |
| `SLUG_TAKEN` | Drop the `existingSlug` pre-check | Concurrent submit still 409s `SLUG_TAKEN`, not a code-less 409 |
| Reserved slug | Submit `signup` as a page address | Rejected client-side *and* server-side, independently |
| Authentication on `teacher-profile` | Call it with no session cookie | 401, no row written |
| Required steps unskippable | POST a skip for `room` | Rejected; the enum has no `room` member, so this must fail to typecheck *and* at the route |

The last row is the compiler tether working as intended: `OnboardingStep` holds
only the skippable steps, so "skip a required step" is not expressible.

---

## Not doing

- **Nothing about `POST /api/teachers` is deferred** — it is deleted here, and
  #382 is closed with it. See Decision 6.
- **The landing page's copy and design.** `docs/implementation-plan.md:281`
  ("7.10 — Landing page / marketing page") is a Phase 7 launch-prep task whose
  sibling 7.9 is already filed as **#387**. 7.10 has never been filed; it is
  filed as part of this work. This PR builds the route and a plain page.
- **Porting the pre-verification rule to the student flow.**
  `api/auth/student-signup/route.ts:42-52` creates `Student` + `Account` before
  verification, and the squatter also chooses the victim's `firstName` and
  `lastName`. Same shape as #382, arguably worse. Not folded in: three e2e specs
  depend on the current shape (`invitations.spec.ts:71` routes new invitees
  through it), and the port must also carry the booking redirect and preserve
  the unclaimed-CRM claim path. Filed, with `MagicLinkPurpose` designed to take
  a `student_signup` member as a one-line addition.
- **`?redirect=` dropped at `/login`.** `proxy.ts:11-13` stamps it,
  `(public)/login/page.tsx` never reads it. A live defect on the same auth path,
  but not this issue's. Filed.
- **Teacher profile photo.** `teacher-screens.md` 1.2 lists it as optional at
  setup; upload does not exist and is **#46**. The Profile step is satisfied by
  the bio alone, so nothing here waits on it.

---

## Testing

**Unit** — step done/skipped resolution over the `OnboardingStep` enum
(exhaustive `switch`, `never` default); page-address derivation, including the
non-Latin-script case that must yield empty; `pageSlugField` against reserved
and malformed values.

**Integration** — `/signup` writes no rows; verify with the marker creates the
`Account`; verify *without* the marker on an unknown email still 400s;
`teacher-profile` rejects an unauthenticated caller, a second call, and a taken
slug; `/signup` re-run on a half-finished account resends; `slug-available`
answers reserved names without a database read and is IP-limited.

Every integration call site uses `freshIp()` from `tests/helpers.ts` — these
routes are IP rate-limited and shared IPs across calls have bitten before.

**E2E** — the whole arc: `/` → `/signup` → inbox → `/signup/profile` →
`/schedule` → skip a step → complete the rest → share → retired.

**This worktree can run neither integration nor e2e**: both are wired to the dev
server on `:3000` and the shared dev database, and a worktree has neither.
`npm run verify` is scoped here to typecheck, lint, unit and components; CI is
the signal for the other two tiers, and the PR body cites the CI run rather than
a local pass.
