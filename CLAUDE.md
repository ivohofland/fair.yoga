# Ethical Yoga App

A free, open-source toolkit for independent yoga teachers. Not a marketplace — a utility. Teachers bring their own students, manage their own classes, control their own business.

## Tech Stack

- **Framework:** Next.js 14+ (App Router) — single process for frontend, SSR, and API
- **Language:** TypeScript with `strict: true` — no `any`, no implicit types, non-negotiable
- **Auth:** Magic link (oslo/crypto) + passkeys (@simplewebauthn/server). No passwords, no SMS. Sessions stored in DB.
- **Deployment:** Single VPS, Docker (Next.js + PostgreSQL), Nginx, Let's Encrypt

→ Full details: `docs/technical-architecture.md`

## Development Principles

**Test-first development.** Every feature starts with a failing test. Write test → see it fail → implement → see it pass → refactor. No PR merges without tests covering the change. This applies at all levels: unit tests for business logic, integration tests for API routes, e2e tests for user flows.

**TypeScript strict mode.** The compiler is the first line of defense. For an open-source project with volunteer contributors, strictness prevents entire categories of bugs.

**Services are framework-agnostic.** Business logic in `src/services/` takes typed inputs and returns typed outputs. No HTTP concerns, no framework imports. API routes are thin wrappers. This makes services independently testable and extractable if a separate API is ever needed.

**Database changes require migrations.** When modifying `prisma/schema.prisma`, always create a migration with `npx prisma migrate dev --name <description>`. Never apply schema changes with raw SQL or `db push` alone — migrations must be tracked so other environments can reproduce the change. Once applied, a migration file is immutable — comments included; see *Comment Discipline*.

**Working a backlog issue?** Invoke the `solve-issue` skill (`.claude/skills/solve-issue/`) before anything else. It carries the whole arc — verify the issue's premise, brainstorm, spec, plan, subagent build, multi-agent PR review, rebase-merge, roadmap — plus the review gates and the failure modes this project keeps hitting. Written to run from an empty context, one issue per session. `.claude/skills/verify/` covers driving the running app.

## Comment Discipline

Comment drift cost PR #300 five review rounds. `generation.ts` and
`template-action-messages.ts` are more prose than code, and the paragraphs that
kept coming back wrong were the ones reaching past their own file.

- **A comment annotates the code it sits on.** Anything wider — counts,
  censuses, set membership, facts about another module — goes in `docs/` and the
  comment links to it. A claim reaching past its file has no owner: the person
  who invalidates it never sees it. `generation.ts`'s header docblock keeps an
  import census of its own importers, and #296 falsified it twice in one issue,
  both times by an edit made in another file.
- **Never write a count or a member list in prose — name the type.** "Every
  `SkipCounts` member" survives a fifth member; a prose roster does not.
  `countSkipReasons`'s docblock had its member counts refreshed and its
  call-site roster left stale, and so described a state this repo was never in.
- **Where membership matters, tether it to the compiler.**
  `satisfies Record<keyof T, true>` — `COUNT_KEYS`
  (`template-action-messages.ts`), `ROOM_SEARCH_SELECT` (`api/rooms/route.ts`)
  — or an exhaustive `switch` with a `never` default (`countSkipReasons`).
  `COUNT_KEYS` replaced an `&&` chain whose docblock promised a fourth member's
  check would land with it; #296 added the member, the promise did not, and the
  predicate asserted more than it checked. An untetherable membership claim is a
  `docs/` entry, not a comment.
- **Comments state what is true now.** What a comment used to say belongs in git
  and the PR body — not "this previously read X", and not `hasIntegerCounts`'s
  paragraph reconstructing how its own wording came to be wrong. If the risk is
  that someone reintroduces the error, add a test or a tether; if neither is
  possible, one line stating the constraint.
- **Prose about a migration goes in `docs/`.** A comment-only edit to an applied
  migration changes its checksum, and `prisma migrate status` compares names — so
  nothing catches it until the next `prisma migrate dev` demands a reset.
  Measured on `20260821120000_cross_family_slot_guard`, which is why that note
  sits in `docs/lock-order.md` instead.

Counts are legitimate in `docs/` and in this file — that is what having an owner
looks like — and they ship with the command that re-derives them, as
`docs/lock-order.md` does for `FOR UPDATE OF`. In a comment, never.

## Core Business Logic

### Pricing Engine

The heart of the app. Income-based pricing with compressed tier spread and scaling teacher rate.

- 5 income tiers with compressed 2× spread. Tier ratios: `[0.65, 0.80, 1.00, 1.20, 1.35]`
- Highest earner never pays more than ~2× the lowest
- Effective teacher rate is a per-class total (not per-student), scales linearly: min_rate (at min_students) → target_rate (at max_students)
- Setting min_rate = target_rate collapses to flat rate
- Negative min_rate allowed (teacher subsidizes room cost)
- Total class cost: `total = room_cost + effective_teacher_rate`
- Per-student price: `student_price = total / sum_of_tier_ratios × student_tier_ratio`
- Post-class billing based on registrations (not attendance)
- Prices are calculated after class ends, not during booking

→ Full algorithm: `docs/product-concept.md` (section: Income-Based Pricing Engine)

### Class Lifecycle

Classes move through states: `draft → open → in_progress → completed → cancelled` (the five members of the `ClassStatus` enum). `full` is a DERIVED display state, not a stored status — it means registrations have reached `max_students`

- `settings_locked` flips true on first registration — economic fields become immutable
- A write may not newly place a class's start instant in the past — `updateClass` refuses a `date`/`startTime` edit that would (409), and `transitionClass` refuses a `draft → open` publish of a class whose start has passed. Service policy, not a constraint: the generator legitimately produces an `open` class whose start has already gone. Two doors, and since #194 they are all of them — `template-sync` was a third writer that rewrote `startTime` past no such guard, and deleting it leaves `updateClass` as the only statement that moves an existing class's `date`/`startTime`
- Terminal status (`completed`/`cancelled`) freezes the whole class — `updateClass` refuses every field, 409; `date` alone is additionally frozen by a DB trigger the retention sweep depends on
- Recurring classes: template generates instances on a rolling 4-week basis, runs indefinitely — **one class per week per template**, so a candidate date whose week already holds one of that template's classes (a cancelled one counts) is skipped rather than filled
- **A template is a stamp, not a live link** (#194): editing one changes nothing that already exists — not the day, time, room, rates or capacity of any generated class, ever. The edit answers with the first week the new schedule can reach — or, for a paused or archived template, with that state instead, because the sweep skips those and no week could be named honestly; the hourly sweep is what lays a reachable one down. The studio family likewise propagates nothing on edit and always did; it does **not** yet key generation per week — `studio-class-generator.ts` has no week predicate, so a studio template moved Tuesday→Thursday generates four Thursdays beside the four standing Tuesdays. #284 carries that half
- **Removal, and the two doors it is not** (#279): a studio class may be
  removed outright only where the hourly sweep cannot undo it — a manually
  logged one, or one whose **calendar date is strictly before the teacher's
  today**. A generated class dated today or later is refused with 409 and told
  to cancel instead, because removing it releases `(templateId, date)` and the
  sweep recreates it within the hour. Deliberately *not* "one whose start has
  passed": the class's `startTime` is a stamp and the generator filters on the
  template's current one, so after a template time edit a started class can
  still be a candidate that same day — the date rule is immune, since no start
  time on a past date is still ahead. A `StudioClassTemplate` is never removed
  at all: archiving withdraws its future window and records what it withdrew
  (`archivedAt`/`withdrawnCount`), and a delete would destroy that record. A
  cancelled studio class is **not** an income record — reporting excludes it —
  so nothing about keeping one is about money; a *generated* one survives
  because it holds its template's date (a cancelled **manual** class holds no
  template date and is freely removable).
- **Editing, and the date that moves only one way** (#276): a studio class
  whose **calendar date is strictly before the teacher's today** is an income
  record — only `studentCount` and `cancelledAt` stay writable, and the PUT
  refuses the whole body rather than partially applying a count smuggled in
  beside a gated field. Today or later the whole schedule is editable,
  cancelled or not: a studio cancellation is recoverable, so it gates nothing.
  `date` is narrower still — it moves only on a **manual** row (a generated one
  holds its `(templateId, date)` against the sweep, which would otherwise
  recreate the class on the freed date within the hour) and only **forwards**,
  because a move landing before today freezes the row on arrival and the typo
  that caused it could not then be undone through the editor. Same shape as the
  `Class` family's #249 rule; logging a class that already happened stays open
  at `/studio-class/new`, which bounds its date field at neither end. The
  predicate is `studio-class-editability.ts`, sibling to the removal one, and
  it answers about the STORED row — the forward-only rule is the route's own
  third gate, because nothing reading the stored row can see a write that ends
  that row's editability
- **One teacher, one slot, across both families** (#296): a teacher holds at
  most one LIVE class per `(date, startTime)` counting `Class` and
  `StudioClass` together, and at most one live template per
  `(dayOfWeek, startTime)` counting `ClassTemplate` and `StudioClassTemplate`
  together. Cancelled classes and archived templates do not participate — each
  family keeps its own spelling of "live" (`status <> 'cancelled'` versus
  `cancelledAt IS NULL`; `isArchived = false` for both template families), and
  a PAUSED template still holds its slot. Enforced by eight triggers rather
  than an index, because the rule spans two tables and PostgreSQL has no
  cross-table unique key. The triggers take no lock, so a residual race
  survives — documented in `docs/lock-order.md` and dissolved by #298, which
  makes this a composite foreign key. Both generators pre-check and skip
  (`blocked_by_other_family`); ten write endpoints across eight route files
  answer 409 naming which family holds the slot
- Auto-cancel: system checks at configured time, cancels if below min_students
- Walk-ins can exceed max_students — teacher rate stays capped at target, extra students lower everyone's price
- After completion: pricing engine runs → payments created → notifications sent

### Waitlist (Hybrid Promotion)

- Before cancel deadline: auto-promote next in queue
- Final hour before the *cancel deadline* (not before the class): switch to first-come-first-claimed broadcast
- Frozen after deadline — no more promotions
- Retention: an entry that never became a registration is reaped once its class
  is terminal and *more than* 365 days past its date — a daily sweep, no migration of its own (the `date` half of that predicate is held by a trigger from #247, see Class Lifecycle)

### Payment Model

- **Level 1 (default):** Platform calculates prices. Student pays teacher directly (bank transfer, cash, etc). Teacher marks paid manually.
- **Level 2:** Teacher connects Mollie (EU) or Stripe (US). Payment links sent to students. Teacher pays processor fees. Platform is never a financial intermediary.

### Communication (Three Layers)

1. In-app notification (real-time via SSE)
2. In-app inbox (persistent record)
3. Email fallback (unread after 30 min — sooner when the linked class starts within 2 h; students can opt out of optional messages, essential booking messages always email)

One-to-many only. No group chat. Teachers use external tools for community.

### Announcements

Teacher sends message to all students of a specific class (or all their students). Creates one Notification per recipient.

## Data Model

Key design decisions:
- `tier_at_booking` on Registration captures income tier at booking time — serves as income history, no separate tracking needed
- `StudentPrivacy` is per-teacher — students control what each teacher can see, default is maximum privacy
- `TeacherRoom` holds private rental rate per teacher — never shared between teachers
- `StudioClass` is disconnected from Room/Student — pure calendar + income tracking
- `Account` owns auth (email identity, sessions, passkeys); `Teacher`/`Student` are optionally-linked profiles — one login serves both hats, teacher pages require a teacher profile and student pages a student one. A teacher may not link a student unilaterally: adding a CRM contact creates only an `Invitation`, and the `TeacherStudent` link forms only once the invitee accepts it (or books a class) — nothing creates an unclaimed `Student` row any more, though pre-existing unclaimed rows (created before this rule) still claim their account on first sign-in. A student who unlinks after being linked leaves a `TeacherBlock`, which keeps that teacher from re-adding them; a plain decline does not — the declined `Invitation` row is itself the tombstone that blocks a re-invite
- Session/passkey tables managed by auth layer, keyed by account

→ Full schema with all fields and types: `docs/data-model.md`

## Information Architecture

**Bottom tab bar** — 64px, exactly 4 tabs with Lucide-style line icons:

**Schedule** (home, `/`) · **Students** (CRM) · **Inbox** (notifications) · **Settings** (index page: recurring, studio classes, rooms, profile)

- The tab bar renders only on the four tab roots; active tab = teal icon + label in a teal-tint pill, gold dot on Inbox when unread.
- **Detail views are separate pages** — tapping a class, student, or notification opens a full page with a back link; the tab bar hides there.
- Class detail is one adaptive page that transforms based on lifecycle stage (draft → open → full → in_progress → completed → cancelled) — `full` here is the derived at-capacity view of `open`, not a stored status
- Dashboard IS the schedule — the Schedule tab at `/` is the home base (`/schedule` redirects there)
- Rooms are in Settings (set-up-once infrastructure)
- Studio classes are a quick entry in the schedule list (visually lighter dashed cards)

→ Full IA reference: `docs/information-architecture.md`
→ Navigation and component patterns: `docs/design-brief.md`

## Design Philosophy

Calm utility, warm minimalism — a thoughtful yoga teacher who happens to be good with numbers. The v2 design system lives in `docs/design_handoff_fairyoga/`; tokens are in `src/app/globals.css` (Tailwind v4 `@theme`, no tailwind.config).

- **Mobile-first** — teachers use this on their phone between and during classes; 640px content column
- **Essentially no motion** — no transitions or hover lift; hover/press are defined color steps
- **Depth without shadows** — sand-soft cards (radius 16) + 1px border on cream; the only shadow is reserved for sheets/modals
- **Cards for classes, rows for directories** — class cards carry the signature registration progress bar (danger→teal fill, ink tick at minimum); directories use ≥56px chevron rows
- **Status: fill encodes time** — outline badge = upcoming, tint = now, solid = done; payment states are text only (✓ Paid / ○ Unpaid), never badges
- **Icons narrowly** — Lucide-style line icons (stroke 1.75, inlined, no dependency) in the tab bar, chevrons, and checkmarks; words come first everywhere else
- **No gamification** — no streaks, no reward badges, no monthly summaries, no loyalty messaging
- **No attention economy patterns** — this is a tool, not an engagement platform
- **Cursor pointer on all interactive elements** — all `<a>` and `<button>` elements get `cursor: pointer` globally via CSS. No need to add `cursor-pointer` class individually.
- Typography: six styles only (`type-display/title/subtitle/body/label/caption/number`) — Georgia bold headings (teal/ink), system sans body, tabular teal numbers
- Colors: teal (#1A5653) primary + success, cream (#F7F4EF) page bg, sand-soft (#F0E9DC) surfaces, brown (#6B5B4E) text, gold (#C4A96A) attention, danger (#B85C5C) outlines/text only — never pure white, no gradients

→ Working design brief: `docs/design-brief.md`
→ Vendored design system: `docs/design_handoff_fairyoga/`

## Key Constraints

- **Privacy first:** No health data. No experience levels. No notes field (GDPR Article 9 risk). Structured optional fields only: phone, birthday, address.
- **Per-class economics:** No pooling across classes. Teachers balance their own week through rate settings.
- **English first:** International from day one, i18n routing deferred.
- **Free platform:** Open source, volunteer development, funded by teacher donations. Transparent running costs page (Dana-inspired).
- **VPS budget:** Everything runs on a single 2GB VPS. No microservices, no separate backend process.

## Open Questions

- Level 2 failed payment retry policy (parked)
- Tier labels — currently 1-5, naming deferred to UX copy phase
- Yogic quotes for tier selection — deferred to UX copy phase
- Tier adjustment framing — deferred to UX copy phase
- GDPR/legal review — parked for proper legal consultation

## Reference Documents

| Document | What it contains |
|---|---|
| `docs/product-concept.md` | Full product concept — all 39 product questions resolved |
| `docs/data-model.md` | Complete data model with all fields, types, relationships, and design notes |
| `docs/technical-architecture.md` | Tech stack, project structure, services layer, auth flow, deployment |
| `docs/information-architecture.md` | 4-tab IA, adaptive class detail, 5 user flows |
| `docs/teacher-screens.md` | 36-screen teacher screen inventory by journey phase |
| `docs/design-brief.md` | Working design brief — v2 tokens, navigation, components, screen patterns |
| `docs/design_handoff_fairyoga/` | Vendored v2 design system — tokens, component reference, guidelines, UI kit |
| `docs/implementation-plan.md` | 8-phase implementation plan with task breakdowns |
| `docs/visual/teacher-journey.docx` | 8-phase teacher journey with user stories and acceptance criteria |
| `docs/visual/student-journey.docx` | 4-phase student journey with user stories and acceptance criteria |
| `docs/visual/pricing-simulator.html` | Interactive pricing simulator with editable tier ratios |
| `docs/visual/data-model.html` | Visual ERD with interactive domain filtering |
