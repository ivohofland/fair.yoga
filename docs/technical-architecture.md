# Technical Architecture — Ethical Yoga App

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) | Single process handles SSR for public pages, SPA for teacher dashboard, and API routes. Low VPS footprint. |
| Language | TypeScript (strict mode) | `strict: true` in tsconfig. No `any`, no implicit types. Catches bugs at compile time, makes volunteer contributions safer. |
| Database | PostgreSQL | Relational model fits the data perfectly (see data-model.md). Mature, free, low resource usage. |
| ORM | Prisma | Type-safe queries generated from schema. Strict TypeScript integration. Easy for volunteers to understand. |
| Auth | Custom (magic link + passkeys) | Magic links via email. WebAuthn/passkeys for returning users. No passwords, no SMS (cost). Tokens are `crypto.randomBytes`, hashed with `@oslojs/crypto` before storage — nothing is signed. `@simplewebauthn/server` handles passkey verification. |
| Email | Resend | Transactional email for magic links, invitations, payment reminders, class reminders, notification fallback. Simple API, generous free tier. |
| Payments | Mollie (EU) / Stripe (US) | Level 1 doesn't need these (manual tracking). Level 2 uses payment links — no card-on-file, no subscriptions. |
| Styling | Tailwind CSS | Utility-first, matches the warm minimalist design brief. No custom CSS files to maintain. |
| Testing | Vitest + Playwright | Vitest for the projects in `vitest.config.ts`, Playwright for e2e. Test-first development — tests are written before implementation. The database-backed unit tiers run against a dedicated `ethical_yoga_test` database, auto-provisioned via `DATABASE_URL_TEST` (see `docs/test-database.md`). |
| Deployment | Single VPS (Docker) | One container running Next.js. PostgreSQL alongside or managed. Nginx reverse proxy. SSL via Let's Encrypt. |

## Development Approach

**Test-first development.** Every feature starts with a failing test. The cycle is: write test → see it fail → implement → see it pass → refactor. This applies at all levels — unit tests for the pricing engine, integration tests for API routes, e2e tests for critical user flows. No PR is merged without passing tests covering the change.

**TypeScript strict mode.** The tsconfig enforces `strict: true`, which enables `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, and all other strict flags. This is non-negotiable. For an open-source project with volunteer contributors, the compiler is the first line of defense against bugs.

### Testing conventions

**Shared fixtures.** `tests/helpers.ts` owns the *mechanical* layer most test files used to hand-roll: `BASE_URL`, `hashToken`, `cookie(token)`, `sessionCookie(token)`, `uniqueSuffix()`, `freshIp()`, and `seedSession(db, accountId)`. `freshIp()` returns an `{ 'x-forwarded-for': '10.a.b.c' }` header object that is unique per call, so every request to an IP-rate-limited route lands in a bucket nothing else has touched — that is what makes the integration suite re-runnable within the hour. It's shared by both the vitest integration suite (`tests/integration/*.test.ts`) and the Playwright e2e suite (`tests/e2e/*.spec.ts`): the module imports nothing from vitest and takes `PrismaClient` as a parameter, so it's usable from Playwright as-is. `cookie()` returns a header object for the integration suite's raw `fetch` calls; `sessionCookie()` is its Playwright-shaped counterpart, for `context.addCookies([...])`. Semantic fixtures — which class is open, which payment is pending, what a teacher's rates are — stay in each test file so a test's setup is readable where it is used. There is deliberately no `makeTeacherWithSession`-style wrapper: `classes-api.test.ts` and `payments-api.test.ts` each keep their own local `makeTeacher(tag)` rather than share one, and the two differ in `firstName`, `bio`, and the email/slug prefix — a shared version would need those as parameters, and the interesting values would vanish behind a helper call for every future caller. A test needing a non-standard session (an already-expired one, say) creates it inline instead of bending the helper: `auth.test.ts`'s expired-session test calls the production `createSession`, then `prisma.session.update`s the row's `expiresAt` into the past.

**Fixture suffixes.** A file that matches its own rows by substring — a `contains`, `startsWith` or `endsWith` on an email, slug or address — keys that match on `uniqueSuffix()` (or an equivalent random part), never on a bare `Date.now()`. Test files load concurrently in the `unit` tier (`fileParallelism: true`), in CI's integration step (`--file-parallelism`) and across Playwright workers, and two files loading in the same millisecond draw the same `Date.now()`: each file's substring then matches the other's rows. In #705 that made a read return seven rows instead of four and a cleanup `deleteMany` fail on `Teacher_accountId_fkey`, because it reached a sibling file's account. `uniqueSuffix()`'s random part leaves only a 1-in-2²⁴ tie within one millisecond. Where a file holds the exact addresses or ids it created, matching them with `in: [...]` is stronger: that cannot reach another file's rows whatever the suffix.

Census (2026-09-29, #705). The files matching fixture rows by substring — 35 at the time; #705's fix itself moved `src/lib/auth/account.test.ts` and `tests/scoped-sweep.test.ts` out of this list, to exact matches, and moved `src/lib/auth/profile-authorization.test.ts`'s `pa-${Date.now()}` key to `uniqueSuffix()`:

    grep -rlE '(contains|startsWith|endsWith)\s*:' --include='*.test.ts' --include='*.spec.ts' --include='*fixtures.ts' src tests

The time-derived values among them with no random part on the same line — candidates, read by hand, since most hits are clock arithmetic (`expiresAt`, deadlines) rather than identities:

    grep -nE 'Date\.now\(\)|getTime\(\)|performance\.now\(\)' $(grep -rlE '(contains|startsWith|endsWith)\s*:' --include='*.test.ts' --include='*.spec.ts' --include='*fixtures.ts' src tests) | grep -v randomBytes

After #705 its identity hits sit only in `src/lib/auth/magic-link.test.ts`, which keys no substring match on them: its scopes and assertions match each address exactly, and its `afterEach` delete matches only literals (`endsWith: '@example.com'`, its cleanup prefix). That delete would reach any concurrent file's `@example.com` rows; none can run beside it, because the file is in `SWEEP_TESTS` and that tier runs serially, after the parallel one.

Neither command sees a substring key that is literal-only. The quoted-literal ones are listed by

    grep -rnE "(contains|startsWith|endsWith)\s*:\s*'" --include='*.test.ts' --include='*.spec.ts' --include='*fixtures.ts' src tests

and at the time printed three lines: `magic-link.test.ts`'s two (above), and `src/app/api/registrations/route.test.ts`'s `endsWith: '@test.local'`, which is ANDed with a `startsWith` on a `uniqueSuffix()`-bearing tag in the same filter. A literal held in a named constant (magic-link's cleanup prefix) shows up only beside a quoted one, so read the hits' files, not just the lines.

**What earns an HTTP guard test.** `requireTeacher`/`requireSession` are the same code on ~40 routes, so a 401/403 ladder per route re-tests one helper forty times. Test the shared guard helpers **once** — that coverage lives in `src/lib/api-utils.test.ts` (401 paths for `requireSession`, 403 + happy paths for `requireTeacher`/`requireStudent`, and `withErrorHandler`'s logging and status classification); a route earns its own HTTP guard test only when its authorization is **bespoke** (its own ownership chain or state guard) or when it carries a **business invariant**. Several route tests keep a ride-along 401 case alongside their bespoke ones, which is fine — what the rule forbids is a full 401/403 ladder on a route whose only guard is the shared one.

**What earns a component test.** The `components` Vitest project (jsdom, `src/components/**/*.test.tsx`, mocking `fetch` and `next/navigation` — no database) exists for wiring a pure function cannot reach: a URL assembled inline beside the label it must agree with, an element that only appears once rendered, a branch that only shows up in the DOM. A component earns a file for that reason and no other. A component whose logic already lives in a tested pure function, or which renders without branching, does not need one — an empty jsdom project is not an invitation to backfill coverage that already exists elsewhere.

**Asserting no alert in e2e.** Next's App Router mounts a visually hidden `#__next-route-announcer__` with `role="alert"` on every page, so a bare `page.getByRole('alert')` never counts zero. Exclude it by id — `page.locator('[role="alert"]:not(#__next-route-announcer__)')` — rather than scoping the query to a parent element: if Next renames the id, the query starts matching the announcer and the assertion fails loudly, where a structural scope fails silently once the markup moves.

**Rate-limited auth routes.** `POST /api/auth/teacher-signup` (IP-keyed, 5/hour, plus a per-email bucket at 3/15 min) and `POST /api/auth/student-signup` (IP-keyed 5/hour, plus an unconditional per-email bucket at 3/15 min) are covered at the HTTP layer, in `teacher-signup-api.test.ts` and `signup-api.test.ts` respectively. Repeated local runs used to exhaust those limiters, which made those files the first to fail on a re-run within the same hour; every such call now carries its own `freshIp()` address, so the IP buckets no longer accumulate across runs. `student-signup`'s per-IP budget test — its only IP-limiter coverage — deliberately reuses an address instead, burning one throwaway bucket to 6. `teacher-signup` also has a dedicated test that omits `x-forwarded-for` and `x-real-ip` entirely, proving its IP check degrades to a shared bucket rather than skipping — see this doc's "Rate limiting" section (under Deployment) for that behavior. `GET /api/teachers/slug-available` — the signup form's live page-address check — is IP-keyed too (60/hour, high enough that normal typing never trips it) and is covered in the same file, for its own availability answer rather than its limiter. `POST /api/auth/magic-link/send` is covered too, in `auth-email-case.test.ts`'s IP-short-circuit test: it deliberately spends both the IP bucket (10 hits from one throwaway address) and, in the same run, the target email's 3/15min bucket, so this route no longer needs a wait-or-trip tradeoff. We do not add a test-mode bypass to production code for test convenience. `POST /api/auth/passkey/authenticate/options` is IP-keyed too (100/hour), covered in `passkey-api.test.ts`. With #187 that route reads nothing from the request body, so there is no address to enumerate and no per-email bucket to pair with the IP one; the budget is there to bound challenge-store churn, since a flood can otherwise evict other callers' in-flight challenges before they are redeemed.

---

## Project Structure

```
ethical-yoga/
├── prisma/
│   ├── schema.prisma          # Data model (source of truth)
│   ├── migrations/            # Database migrations
│   └── seed.ts                # Development seed data
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── (public)/          # Public routes (no auth required)
│   │   │   ├── [slug]/        # Teacher's public booking page (SSR)
│   │   │   ├── login/         # Magic link + passkey login
│   │   │   └── verify/        # Magic link verification
│   │   ├── (teacher)/         # Teacher dashboard (auth required)
│   │   │   ├── schedule/      # Schedule tab (home)
│   │   │   ├── students/      # Students tab (CRM)
│   │   │   ├── inbox/         # Inbox tab (notifications)
│   │   │   ├── settings/      # Settings tab
│   │   │   └── class/[id]/    # Class detail (adaptive screen)
│   │   ├── (student)/         # Student views (auth required)
│   │   │   ├── bookings/      # My upcoming classes
│   │   │   └── settings/      # Privacy & preferences
│   │   └── api/               # API routes
│   │       ├── auth/          # Magic link & passkey endpoints
│   │       ├── classes/       # Class CRUD & lifecycle
│   │       ├── registrations/ # Booking, cancellation, walk-ins
│   │       ├── payments/      # Payment tracking & webhooks
│   │       ├── notifications/ # Notification endpoints
│   │       └── webhooks/      # Mollie/Stripe callbacks
│   ├── services/              # Business logic (framework-agnostic)
│   │   ├── pricing.ts         # The pricing engine
│   │   ├── pricing.test.ts    # Pricing engine tests
│   │   ├── class-lifecycle.ts # Class state machine
│   │   ├── class-lifecycle.test.ts
│   │   ├── waitlist.ts        # Hybrid waitlist promotion
│   │   ├── waitlist.test.ts
│   │   ├── notifications.ts   # Notification row writer + SSE emit
│   │   ├── notifications.test.ts
│   │   ├── push-dispatch.ts   # Web push sweep — see Web Push below
│   │   ├── push-dispatch.test.ts
│   │   ├── payments.ts        # Payment creation & tracking
│   │   ├── payments.test.ts
│   │   └── class-generator.ts # Class family's half — see Entry Generator below
│   ├── lib/                   # Shared utilities
│   │   ├── auth.ts            # Session management, magic link tokens
│   │   ├── db.ts              # Prisma client singleton
│   │   ├── email.ts           # Resend wrapper
│   │   └── types.ts           # Shared TypeScript types
│   └── components/            # React components
│       ├── ui/                # Base components (buttons, cards, inputs)
│       ├── schedule/          # Schedule-specific components
│       ├── class/             # Class detail components
│       ├── students/          # Student CRM components
│       └── layout/            # Navigation, tabs, modals
├── tests/
│   ├── e2e/                   # Playwright end-to-end tests
│   │   ├── teacher-onboarding.spec.ts
│   │   ├── class-booking.spec.ts
│   │   ├── payment-flow.spec.ts
│   │   └── waitlist.spec.ts
│   └── integration/           # API route integration tests
│       ├── classes.test.ts
│       ├── registrations.test.ts
│       └── payments.test.ts
├── tsconfig.json              # strict: true
├── vitest.config.ts
├── playwright.config.ts
├── docker-compose.yml         # Dev: Next.js + PostgreSQL
├── Dockerfile                 # Production build
└── .github/
    └── workflows/
        └── ci.yml             # Run tests on every PR
```

---

## The Services Layer

The `src/services/` folder is the heart of the application. These are pure TypeScript functions with no framework dependency — they take typed inputs and return typed outputs. API routes are thin wrappers that handle HTTP concerns (parsing request, checking auth, returning response) and delegate to services.

This separation means services are independently testable (no HTTP mocking needed) and could be extracted to a standalone API later if mobile apps require it.

### Work that must not be awaited

A few service functions must never sit on a request's critical path — their
duration or failure would leak something the response is meant to withhold.
`deliverInvitation` (`services/invitations.ts`) is the case that named the
rule: awaited, it turns an email-provider outage into a 500 for an
unregistered address while a registered one still answers normally, which is
the account-enumeration oracle #166 closed.

These functions return `FireAndForget` (`src/lib/fire-and-forget.ts`), an
alias for `void`. Returning no promise is what enforces the contract —
`.then()` and `.catch()` on the result are compile errors, so a caller cannot
couple its response to the work even without knowing why they shouldn't.
A bare `await` on one is legal and inert: it yields a microtask and nothing
else.

**Writing a new one:** return `FireAndForget`, start the work in a
`void (async () => { … })().catch(…)`, and handle the rejection inside — there
is no promise left for a caller to attach a handler to, so an unhandled
rejection is the default if the function does not own its own. Take whatever
context the log line needs (an id, which caller) as parameters. Nothing may
precede the IIFE: a statement placed before it throws synchronously into the
caller, escaping the `.catch` entirely.

`grep -rn '): FireAndForget' src/` lists every function under this rule.

### Error responses

A refusal is `respondError(message, status, code)` for a single literal code
known at the call site, or `respondRefusal(refusal)` for one read whole off a
`Record<Reason, CodedRefusal>` map — splitting such a refusal into separate
`status`/`code` arguments stops compiling once its reasons span more than one
status, because a union-typed `code` no longer pins a single status (#649).
The code comes from
`src/lib/api-error-codes.ts`, which fixes one status per code: a 409 without
a code, or a code at another status, does not compile. A `CodedRefusal` value
is built with `codedRefusal(code, message)` from that same module, which reads
`status` out of the registry rather than letting a call site hand-type it
beside `code`. Clients branch on the code through `readError`
(`src/lib/client-errors.ts`) rather than on the
status — two refusals can share a status and mean different things. The
exceptions are the statuses `ApiErrorStatus` excludes, today 401 and 429: no
code can ever carry one, so a client that must recognise a dropped session or
a rate limit has only the status to read, and several do. Tests assert
it with `expectRefusal` (`tests/api-assertions.ts`), never the message, so
copy can change without touching a test.

**The one exception is comparing a message against its own exported
constant, never a literal — and only where several doors share one code and
the sentence is the only thing that says which door answered.**
`src/app/api/invitations/[id]/shared.ts`'s `DECLINED(door)` is the worked
example: `edit`, `remove` and `resend` all send `DECLINED_IS_PERMANENT`, so
the code cannot tell a caller which sentence was sent, and
`cas-scope.test.ts` compares the body against `DECLINED_MESSAGE.remove` (its
own exported entry), never the quoted sentence, so rewording the copy stays
free while the door-routing pin still holds. This is the only reason to write
a NEW server-side assertion that reads `error.message` (spec §8.3). Older
assertions predate the rule and still read messages directly — enumerate them
with

```bash
grep -rnE "error\.message\)\.(toBe|toContain)\('" tests/integration src/app/api
```

— so finding one is not a licence to add another. Without this written down, whoever next
meets a mutation that leaves a test green cannot tell "nothing caught this"
from "nothing was ever meant to" — the question #197's own PR (`8e22db04`)
had to answer the hard way, by re-deriving the acceptance criterion from the
issue itself after a first pass pinned prose at five sites that did not need it.

A client `catch` binds its error, and a failed request logs through
`logRequestFailure` (`src/lib/client-errors.ts`). Its `context` carries
ids, flags and enum-like values — never an email, a name, a sign-in code or anything else the
user typed, which the type cannot tell from an ID. `err` itself can quote the
start of a response body, which matters if a client error sink is ever plugged
in. `src/components` and `src/app` refuse a bare `catch` and a parameterless
`.catch` handler (or one whose parameter is `_`-named) by lint
(`bareCatchSelector` and `discardedRejectionSelector` in `eslint.config.mjs`);
a catch that is correct as bare says why in its `eslint-disable-next-line`.
`src/lib` is outside the rule; its client helpers log through the same helper,
held by review rather than lint. The design is in
`docs/superpowers/specs/2026-09-29-bare-catch-logging-design.md`.

**Already done is not an error.** A request whose goal the server can prove
already holds answers `respondUnchanged(data)`: 200, `{ data, outcome:
'unchanged' }`, no write, no side effect. "Prove" means the stored state
equals what the request asks for, including every value the request carries;
a request carrying values the stored row lacks is not a retry of the request
that made it. In a handler the check sits:

1. after authentication and ownership — before them, "unchanged versus 404"
   would answer whether something exists;
2. after refusals that make the goal moot — the class is cancelled, the
   payment is settled;
3. before every other status, window or capacity refusal, so a retry is never
   refused for a state its own first attempt created.

A delete of a row that is already gone cannot be proven a retry, so it stays
404 `NOT_FOUND`, and the component that issued the delete treats that code as
done. A create that meets its twin stays a refusal naming the conflicting
row.

**Copy.** A refusal message:

- uses the user's terms — never a model or table name, a status literal, an
  id, or a list of valid values;
- says what is true, then the next step when there is one;
- says "someone else" only when the server knows it was not this user;
- is a full sentence in sentence case with a closing period — no "Invalid…",
  "Cannot…: …" or "Must be…", and no apology;
- may vary with the action or the row it names, while its code keeps one
  meaning;
- names anything in the UI by the label the UI shows.

**Adding a code:** one registry entry at its status; the route sends it; a
test asserts it with `expectRefusal`. A reason → response map types its
values `CodedRefusal`, so each entry's status is checked against its own code.
`classifyApiError`'s fallbacks (`src/lib/api-errors.ts`) carry codes too.

### Relation loads over platform-wide sets

**The mechanism.** Prisma loads a relation (`include` / nested `select`) with
a second statement, one parent key per row. For a **composite** relation —
one keyed on more than one column, such as `Class.calendarEntry` — that key
is a row value, and the statement Prisma sends is a row-value `IN` list:
`WHERE ("id","kind","live") IN (($1, $2, $3), ...)`. Postgres parses that
list into a nested expression tree and fails with `54001 stack depth limit
exceeded` at about 7,500 tuples on the default `max_stack_depth` (2 MB) —
measured by bisection on Prisma's bound-parameter path, between about 7,500
and 7,750 parents (#674); in plain SQL, 3,000 tuples pass and 8,000 fail. A
**single-column** `IN` list is flat — Postgres compiles it to
`= ANY(array)` — and stays safe at any size tested (32,000 values). Relation
**filters** (`where: { calendarEntry: { cancelledAt: null } }`) compile to a
`JOIN`, not an `IN` list, and are unaffected. Only relation *loads* over a
composite key are exposed.

**The rule.** A sweep whose parent set grows with the whole platform never
loads a relation over that set in one statement — it reads its snapshot in
keyset pages through `readInPages` (`src/lib/read-in-pages.ts`), which pages
at `SWEEP_PAGE_SIZE` (500) and leaves the keyset — the `where` and matching
`orderBy` — to the caller, so every site keeps Prisma's nested result type.
Per-tenant reads (a teacher's or a student's own history) are left alone: see
the verdict below.

**How the ceiling tests reproduce it.** `tests/stack-ceiling.ts`'s
`lowStackClient` opens a `connection_limit=1` Prisma client and lowers
`max_stack_depth` for that session (a `connection_limit=1` client is what
makes a session-level `SET` reach every later query on it). The harness
asserts that an unpaged `CEILING_ROWS` load fails with `54001`
(`isStackDepthError`) and that a `SWEEP_PAGE_SIZE` page passes. Each per-site
test then seeds a `CEILING_ROWS` parent set and asserts the paged read
completes on the lowered stack without returning a row twice;
`expectLowered` confirms the session is actually running under it, so a
test cannot pass by silently running on a default-stack connection. Un-paging a site's read turns its test red with
`54001`, which is how each was verified. The per-site tests live in
`src/services/sweep-page-ceiling.test.ts`.

**Per-tenant verdict.** A read bounded by one teacher's or one student's own
history is left unpaged — including the GDPR export, `/schedule/past`,
reporting, and the unfiltered `GET /api/classes` / `GET /api/studio-classes`,
among other per-tenant reads. At 6
classes a week, one teacher reaches 7,500 calendar entries only after about
24 years (7,500 ÷ 6 ÷ 52 ≈ 24), and a student's bookings or GDPR export is
smaller again. Not a defect anyone will hit.

**Re-deriving the census.** Composite relations:

```bash
grep -n "fields: \[[^]]*,[^]]*\]" prisma/schema.prisma
```

Load sites (excluding tests — read each hit to separate a load from a
filter):

```bash
grep -rnE "\b(calendarEntry|classes|studioClasses|teacherRoom|classTemplates|studioClassTemplates|scheduleRule)\s*:\s*(\{|true)" src | grep -v '\.test\.ts'
```

Cross-tenant sites — each a background sweep whose parent set grows with the
whole platform — paged through `readInPages`:

| Function | File | Note |
|---|---|---|
| `autoCancelClasses` | `class-transitions.ts` | windowed (`cancelCandidateDates`) and the registration count moved to a separate per-page `groupBy` |
| `autoTransitionToInProgress` | `class-transitions.ts` | |
| `autoCompleteClasses` | `class-transitions.ts` | |
| `reconcileWaitlists` | `waitlist-reconciliation.ts` | |
| `readGenerationCandidates` | `class-generator.ts` | |
| `readStudioGenerationCandidates` | `studio-class-generator.ts` | |
| `getUnreadForEmailFallback` | `notifications.ts` | keyset on `(createdAt, id)`, not `id` alone |
| `readDuePayments` | `payment-reminders.ts` | |
| `processClassReminders` | `class-reminders.ts` | windowed (`reminderCandidateDates`); a class's registrations are read per class (plus a count when the teacher's reminder is due), never as a relation load over the paged set |

**Three pitfalls the next paged read will meet:**

- TypeScript infers `T = unknown` from an inline callback passed to
  `readInPages` — pass the type argument explicitly, derived from the page
  function's own return type (`Awaited<ReturnType<typeof readXPage>>[number]`).
- Spreading a cursor into a `where` that already uses that key — an `id: { in
  }`, or a top-level `OR` — replaces the existing filter instead of narrowing
  it. Merge the cursor into the existing key, or combine both under a
  top-level `AND: [...]`.
- A keyset `orderBy` and its cursor comparison must describe the same strict
  total order. A column that is not itself unique (`createdAt`) needs a
  tie-break on `id` in both the `orderBy` and the cursor, or a page boundary
  landing inside a tie skips or repeats rows.

### Pricing Engine (`services/pricing.ts`)

The most critical piece of logic. Takes a class's economic settings and its registrations, returns the price each student pays.

```typescript
// One of five discrete income bands — not a bare number. See src/lib/tiers.ts.
type IncomeTier = 1 | 2 | 3 | 4 | 5;

interface ClassPricingInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  studentTiers: IncomeTier[]; // one tier per charged student
}

interface PricedStudent {
  tier: IncomeTier;       // the tier this student was charged at
  ratio: number;          // the tier ratio applied
  price: number;          // this student's price, after largest-remainder allocation
}

interface PricingResult {
  effectiveTeacherRate: number;
  totalCost: number;
  studentCount: number;
  students: ReadonlyArray<PricedStudent>; // one record per charged student, same order as studentTiers
}

function calculateClassPricing(input: ClassPricingInput): PricingResult {
  // Step 1: Calculate effective teacher rate
  //   Linear interpolation between minRate and targetRate
  //   based on student count between minStudents and maxStudents

  // Step 2: Calculate total class cost
  //   roomCost + effectiveTeacherRate (teacher rate is per-class, not per-student)

  // Step 3: Distribute across tiers using compressed spread
  //   Tier ratios: [0.65, 0.80, 1.00, 1.20, 1.35]
  //   Each student's share = totalCost × (theirRatio / sumOfAllRatios)

  // Step 4: Return per-student records, each pairing a price with the tier
  //   and ratio it was computed from
}
```

This function is pure — no side effects, no database calls. It's the most tested code in the system.

### Class Lifecycle (`services/class-lifecycle.ts`)

Manages the class state machine:

```
draft → open → in_progress → completed        (+ cancelled, off to one side)
```

`full` is derived from the registration count, never stored. `cancelled` left
`ClassStatus` in issue 327: it is `CalendarEntry.cancelledAt`, so a cancelled
class keeps whatever status it held and cancellation is not a transition — see
`api/classes/[id]/cancel/route.ts`, which is its own endpoint for that reason.

```typescript
interface ClassTransition {
  from: ClassStatus;
  to: ClassStatus;
  guard: (classData: Class) => boolean;
  onTransition: (classData: Class) => Promise<void>;
}

// Key transitions:
// open → in_progress:      when the class start instant is reached
// in_progress → completed: when the teacher finishes the class (from 15 min
//                           before its end, but never before its start), or
//                           automatically 15 min after its end
// completed triggers:      pricing calculation → payment creation → notifications
//
// Not a transition: cancellation. `auto_cancel_check` firing below minStudents
// writes `cancelledAt` on the entry and leaves `status` alone.
```

### Waitlist (`services/waitlist.ts`)

Implements the hybrid promotion model:

```typescript
// More than 1h before class start: auto-promote the queue head
// Final hour before start: first-come-first-claimed broadcast
// At or after start: frozen — nothing happens
async function handleSpotFreed(db, classId, now?): Promise<SpotFreedResult> {
  const cls = await db.class.findUnique({
    where: { id: classId }, include: { calendarEntry: true }, ...
  });
  // Liveness is TWO reads since #327: the status, and the entry's cancelledAt.
  if (!cls || cls.status !== 'open' || cls.calendarEntry.cancelledAt !== null) {
    return { action: 'none' };
  }

  // Reads only the entry's date/startTime and a timezone — the cancel
  // deadline plays no part in the window (#236).
  const window = getWaitlistWindow(cls.calendarEntry, tz, now);
  if (window === 'frozen') return { action: 'frozen' };

  if (window === 'auto_promote') {
    // promoteNext: under the Class row lock, checks capacity, promotes the head
    return ...;
  }

  // first_come_first_claimed: under the Class row lock, counts free seats
  // (#212 — it used to notify without checking), declines if a broadcast
  // already stands for this claim window (#691), then notifies everyone
  // waiting. The first claim wins; claimSpot re-checks capacity.
  return ...;
}
```

### Notification Dispatcher (`services/notifications.ts`)

`createNotification` / `createBulkNotifications` do only two things: write the
`Notification` row (the inbox, layer 2) and call `emitToBus`, a
fire-and-forget publish to the in-process SSE bus (layer 1) that clients treat
as a refresh hint, never as the payload itself. Neither function schedules
email or push — those are separate sweeps, each reading committed
`Notification` rows on its own column and its own cutoff: `email-fallback.ts`
(layer 3, `emailSent`/`isRead`, see Cron Jobs) and `push-dispatch.ts` (layer 4,
`pushHandledAt`, see Cron Jobs and Web Push below). Push and email are
decided independently of each other.

### Web Push (`lib/push/`, `services/push-dispatch.ts`)

Full design: `docs/superpowers/specs/2026-10-02-web-push-design.md`.

- `lib/push-policy.ts` decides WHETHER (`shouldPush`, keyed by the
  `StudentPushGroup`/`TeacherPushGroup` preference columns a notification
  type maps to), WHAT (`buildPushPayload` — redacts the body to a fixed line
  for money groups, caps title and body in raw UTF-8 bytes, then shrinks the
  body further when JSON escaping would take the serialised payload past
  `PUSH_PLAINTEXT_MAX_BYTES` — the push service's 4096-byte limit less RFC
  8291's encryption overhead), and urgency (`pushUrgency`).
- `lib/push/{vapid,encrypt,send}.ts` implement RFC 8292 VAPID and RFC 8291
  payload encryption on `node:crypto`. `sendPush` follows no redirect
  (`redirect: 'manual'`) and reports an outcome for everything the push
  service or the network can do: a 2xx is `delivered`; a 404/410 is `gone`,
  the subscription is dead; stored keys it cannot encrypt against
  (`InvalidSubscriptionKeysError`) are `invalid`; any other status, a
  redirect, a network error or a timeout is `failed`, carrying the error as
  `cause` or the start of the response body as `reason`. Any other throw — a
  signing or encryption fault — propagates.
- `lib/push/endpoint.ts`'s `isPushServiceEndpoint` is the host allowlist
  `POST /api/push/subscriptions` applies before it stores an endpoint:
  `https:` on a known browser push service and nothing else, because the
  sweep POSTs to whatever is stored. `savePushSubscription`
  (`services/push-subscriptions.ts`) keeps each account to
  `MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT` rows, evicting the least recently
  active (`lastUsedAt ?? createdAt`) in the same transaction as the upsert.
- `services/push-health.ts`'s `runPushDispatchTick` is wired into the
  scheduler (Cron Jobs, below) and wraps `services/push-dispatch.ts`'s
  `dispatchPushes`, the sweep: a worker claims each committed `Notification`
  row just before its sends, with a compare-and-swap on `pushHandledAt` so
  concurrent runs send once, and rows it never reached are left unclaimed.
  It sends to every subscription on the resolved recipient's account, deletes a
  subscription whose outcome is `gone` or `invalid`, and never retries a
  `failed` one. A sender throw is a fault, not a verdict on the row: it
  rejects the tick, which the scheduler logs and records as `lastError`, and
  the subscription stays. A row already older than the stale cutoff
  (`PUSH_STALE_AFTER_MS`, 15 minutes) when a tick reads it is retired without
  sending — a row still within the cutoff at that read can still be sent even
  if it ages past it before the tick finishes. When `diagnoseVapidConfig()`
  (`lib/push/config.ts`) finds the `VAPID_*` environment unusable, every row
  is claimed and stamped without sending (and counted `unsendable` unless
  `VAPID_*` is simply unset); once per process the sweep warns when no
  `VAPID_*` variable is set, and logs an error naming the reason for any
  other problem.

### Entry Generator (`services/entry-generation.ts`)

Runs hourly as part of the in-process scheduler (see Cron Jobs below). For each template whose `ScheduleRule` is active and unarchived it tops up the rolling 4-week window — **at most one entry per week per template** (#194) — and reports every candidate date it could **not** fill along with the reason:

```typescript
// generateEntriesForRule — one template, one window, either family.
// Real identifiers, bodies elided: `dates`, `free` and `startTime` are the
// actual locals, `getNextOccurrences` and `classStartInstant` the actual
// helpers. A sketch that invents names is a sketch nobody can grep, which is
// how the loop this replaced went on being documented after it was gone.
// `dayOfWeek`, `startTime` and `teacherId` left `ClassTemplate` for
// `ScheduleRule` in issue 298, so they're reached through `template.scheduleRule.*`.
// `startTime` is `ScheduleRule.startTime` itself (a `@db.Time` `Date`) — no
// `timeToHHmm` round trip, since `classStartInstant` and
// `CalendarEntry.startTime` (issue 327 Task 1) both want that type directly.
const startTime = template.scheduleRule.startTime;
const dates = getNextOccurrences(template.scheduleRule.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
  .filter((d) => classStartInstant(d, startTime, tz) > startDate)
  .slice(0, DEFAULT_WEEKS);

// ONE query per question, and since #194 there are two. Both read
// `CalendarEntry`, not `Class`: issue 327 moved the calendar identity there,
// so a teacher's occupancy is one table spanning both families. This one
// classifies each candidate DATE: already generated, blocked by a cancelled
// instance of this template, or the teacher's slot taken by another entry —
// of either family, which is why the pre-check needs no sibling read.
const occupants = await db.calendarEntry.findMany({
  where: { teacherId: template.scheduleRule.teacherId, date: { in: dates } },
  select: { scheduleRuleId: true, kind: true, date: true, startTime: true,
            durationMinutes: true, cancelledAt: true },
});

// And this one classifies its WEEK — `already_this_week`. Keyed on
// `scheduleRuleId`, not `teacherId`: it rides `@@unique([scheduleRuleId,
// date])`, and the date-scoped read above structurally cannot see the class
// that holds a week from a DIFFERENT day, which is the whole case it exists
// for. No liveness filter, deliberately — a cancelled entry holds its week.
const heldWeeks = new Set(
  (await db.calendarEntry.findMany({
    where: { scheduleRuleId: template.scheduleRuleId, date: { gte: weekStart, lt: weekEnd } },
    select: { date: true },
  })).map((e) => mondayOf(e.date)),
);

// The reasons are what the teacher and the operator get told.

// TWO inserts since #327, and only the first can conflict. `skipDuplicates`
// compiles to a bare `ON CONFLICT DO NOTHING` — no conflict target, so it
// covers `CalendarEntry_teacher_slot_excl` as well as the unique key — and a
// date lost to a concurrent insert costs that date and nothing else. The
// child rows below are keyed on the entry ids that landed, so nothing is
// left for a second `ON CONFLICT` to catch.
const inserted = await db.calendarEntry.createManyAndReturn({
  data: free.map((date) => ({ /* rule's calendar fields + date */ })),
  skipDuplicates: true,
  select: { id: true, date: true },
});
if (inserted.length > 0) {
  // The family's own write, not this function's: `class.createMany` under
  // `CLASS_GENERATOR`, `studioClass.createMany` under `STUDIO_GENERATOR`,
  // each keyed on `entry.id` and carrying only that family's economics.
  await family.createChildren(db, template, inserted);
}

return { created: inserted.length, skipped }; // GenerationResult
```

**Not a per-date insert loop, deliberately.** It was one until #164. Every production path into this function runs inside an interactive transaction the CALLER owns — stated as that property rather than as a roster, which is what went stale here and in the function's own docblock. Re-derive the paths with `grep -rn 'generateInstancesForTemplate(\|generateStudioInstancesForTemplate(' src/ | grep -v '\.test\.'` — both adapters, since one function serves both families — and note that the grep is not exhaustive on its own: `CLASS_FAMILY.generate` and `STUDIO_FAMILY.generate` (the two `*-template-lifecycle.ts` files) hold their adapters by reference, so the shared `pauseOrResumeRule` (`services/rule-lifecycle.ts`) reaches them without a call site the grep can see. Prisma does not savepoint individual queries inside an interactive transaction, so a per-date insert that hit a unique violation aborted the whole transaction, and a clash on the last date let `COMMIT` return the `ROLLBACK` tag with no error at all. A teacher resuming a template was told it worked while the template stayed paused. See `docs/superpowers/specs/2026-08-11-generator-slot-reporting-design.md`.

**One generator, two families, since #284.** The code sketched above is `generateEntriesForRule` (`services/entry-generation.ts`), which both families run. Each supplies a `GeneratorFamily` descriptor naming its `CalendarEntry.kind`, its log noun, its child table, and how to read and write its own children — `CLASS_GENERATOR` in `services/class-generator.ts`, `STUDIO_GENERATOR` in `services/studio-class-generator.ts` — and each keeps a named per-template adapter (`generateInstancesForTemplate`, `generateStudioInstancesForTemplate`) because call sites and comments name it. The week key, the skip reasons and the `GenerationResult` are therefore the same code on both sides rather than the same shape written twice; the studio family gained the week key with the merge. The same file holds `claimRuleForGeneration` and `probeFirstEffectiveWeek`, likewise one copy for both.

**A template edit reaches no generated class.** `updateClassTemplate` (`services/class-template-lifecycle.ts`) still touches no generated class: since #194 there is no propagation service. But it is no longer a single-table, single-statement write — issue 298 split the wire schema across `ClassTemplate` and `ScheduleRule`, so its `$transaction` writes `ClassTemplate` always and `ScheduleRule` only when the edit touches a slot field (`classType`/`dayOfWeek`/`startTime`/`durationMinutes`), up to three statements across the two tables. The transaction also takes the child row's `FOR UPDATE` lock the sibling template functions serialise against (`docs/lock-order.md`, "The child row is the lock node for the template families"), not merely `SET LOCAL lock_timeout` over a single `update`. The PUT then runs a read-only probe that predicts the first week the new schedule can reach, and says so in its response.

---

## Authentication Flow

### Magic Link (primary)

Nothing here is signed. The token is `crypto.randomBytes(32)`, unguessable on
its own merits; `@oslojs/crypto`'s only job is hashing it (SHA-256) before the
row is written, so a database read yields no usable token — same shape as a
password hash, not a signature.

Every mint also binds the token to `fair_yoga_origin`, a long-lived nonce
cookie identifying the browser that asked for the link (`deliverSignInLink`,
the one function all three link-emitting routes go through). That is what
`/verify` uses to tell a click on the requesting browser from a click
anywhere else — a forwarded link, a second device, a mail scanner
prefetching it — without ever asking the user which one this is:

```
1. User enters email on /login (or /signup, or a booking page)
2. API mints a random token, stores its SHA-256 hash in DB with a 15-min
   expiry, bound to a hash of this browser's fair_yoga_origin nonce
3. Resend delivers email with link to /verify?token=xxx
4. /verify checks the opening browser's nonce against the bound hash:
   - matching nonce: consumes the token, creates a session cookie (httpOnly,
     secure, sameSite)
   - no cookie, or another browser's: consumes nothing — stamps a one-time
     6-digit code on the token instead and shows it, for the browser that
     actually asked for the link to redeem via POST /api/auth/magic-link/claim
5. Redirect to dashboard (teacher) or bookings (student), once a session exists
```

On iOS, an installed home-screen app keeps its own cookie jar, separate from
the browser's, so a link tapped in Mail opens in the browser and takes the
code branch; the app redeems the code like any second browser (#723). `/login`
offers the code field without a fresh request ("Have a code from the email
link?"), because iOS may reload a backgrounded installed app while the
person is reading their mail.

### Passkey (returning users)

```
1. User clicks "Sign in with passkey" on /login
2. Browser triggers WebAuthn ceremony via @simplewebauthn/browser
3. Server validates assertion via @simplewebauthn/server
4. Creates session cookie, same as magic link flow
5. Redirect to dashboard
```

### Installed app start URL

`/start` (`src/app/(public)/start/page.tsx`) is the installed app's
`manifest.ts` `start_url`. It routes by profile — a teacher to `/schedule`, a
student-only account to `/bookings`, a two-hat account to the teacher home,
and a signed-out visitor to `/login` rather than the public pitch `/` shows —
and it stays outside `src/proxy.ts`'s matcher deliberately: the matcher would
turn the signed-out case into `/login?redirect=/start`, trading `/start`'s
own per-profile routing for a fixed redirect target nobody asked for. Pinned
by `tests/integration/pwa.test.ts`.

### Unauthenticated API routes

`find src/app/api -name route.ts` finds **70** routes. **10** carry no session
guard; **6** of those are rate-limited (`magic-link/claim`, `magic-link/send`,
`student-signup`, `teacher-signup`, `slug-available`,
`passkey/authenticate/options`), leaving **4** with neither:

| route | why that is correct |
|---|---|
| `health` | Public health check. |
| `auth/magic-link/verify` | Token is `crypto.randomBytes(32)` — 256 bits, stored hashed, 15-minute TTL. Brute force is infeasible. |
| `auth/passkey/authenticate/verify` | Gated on a one-time 5-minute challenge plus WebAuthn signature verification; `redirect` is `relativePath.optional()` in `passkeyAuthVerifySchema`. |
| `teacher-photos/[photoId]` | Public by design (#46): the teacher's public page shows the photo to signed-out visitors. The id is a per-upload `randomUUID`, regenerated on every upload and replace, and the route answers 404 once a photo is replaced or its teacher erased. |

Re-derive with:

```sh
find src/app/api -name route.ts | wc -l
for f in $(find src/app/api -name route.ts | sort); do
  ids=$(grep -ohE "require[A-Za-z]+\(|getSession[A-Za-z]*\(|resolveProfileAuthorization\(|resolveTicketOnlyProfileAuthorization\(|CRON_SECRET|checkIpRateLimit\(|checkRateLimit\(|checkStudentWriteLimit\(" "$f" \
        | tr -d '(' | sort -u | tr '\n' ' ')
  printf "%-60s %s\n" "${f#src/app/api/}" "$ids"
done
```

The loop prints one row per route and expects all of them to be read, rather
than filtering to a count. A filtering grep gets this wrong:
`notifications/stream` guards with `getSessionToken`, not `requireSession`, so a
pattern listing only the `require*` helpers files it as unguarded.

Two further limits worth knowing: `sort -u` collapses a file to one row per
unique identifier, so a file with one guarded method and one unguarded method
beside it (a guarded `GET` next to a wide-open `POST`, say) reads as a single
guarded row — the command finds unguarded *files*, not unguarded *methods*.
And it only recognizes the guard helpers named in the pattern: the two
profile routes, `account/teacher-profile` and `account/student-profile`,
call no `require*` helper themselves — each authorizes through a resolver in
`src/lib/auth/profile-authorization.ts` (`resolveProfileAuthorization`,
`resolveTicketOnlyProfileAuthorization`) that accepts a signup ticket or a
live session, which is why the pattern names those resolvers. A route that
guards through a helper the pattern does not name prints an empty row.

### Passkey authentication options

`POST /api/auth/passkey/authenticate/options` never sends `allowCredentials`,
and reads nothing at all from the request body.

It used to accept an email, look up the account, and return that account's
credential ids. The key was absent for an unknown address, an empty array for
an account with no passkey, and a populated array otherwise — so an
unauthenticated caller could read account existence, passkey count and the
credential ids themselves off the response shape.

Equalising the response would not have been enough. The lookup is a timing
signal in its own right: one query for an unknown address, two for a known one.
Deleting the input removes both channels and leaves an invariant a reviewer can
check from the signature — no request-controlled value reaches the response.
`generatePasskeyAuthenticationOptions` therefore takes no parameter rather than
an unused optional one, so restoring the leak is a signature change.

**The cost.** Without a credential list the authenticator cannot pre-select,
so the ceremony needs a *discoverable* credential. Registration uses
`residentKey: 'preferred'`, so platform authenticators (iCloud Keychain,
Windows Hello, Android) are unaffected, while a hardware key whose resident
slots are full produces a non-discoverable credential that can no longer sign
in — that person falls back to the magic link, which is what the sign-in
button's failure copy points at.

**This population cannot be measured from our data.** Knowing whether a stored
credential is discoverable needs the `credProps` extension at registration,
which this codebase neither requests nor stores; `transports` is the only proxy
(a row without `'internal'`). The decision rests on inference about
authenticator behaviour, not measurement.

### Passkey user verification

Both ceremonies ask the authenticator for user verification (`'required'`) and
both verifiers require it, derived from one declaration in
`src/lib/auth/passkey.ts` (`USER_VERIFICATION`) so the request and the check
cannot disagree (#732). A passkey is therefore two-factor: the device, plus the
PIN or biometric that unlocks it.

The options used to ask for `'preferred'` while the verifiers, by
`@simplewebauthn/server`'s default, required verification anyway. Adding a
passkey with an authenticator that honours "preferred" by skipping it — a
roaming security key with no PIN set — completed the browser ceremony and was
then refused by the server, behind generic copy. With `'required'` the browser
stops that key before anything is sent for verification. That the browser's
own UI then says why (Chrome typically offers to set a PIN on the key) is
inference about real browsers, not measurement: the e2e test drives Chromium's
CDP virtual authenticator, which has no UI.

Sign-in is different. Chromium's virtual authenticator refused a UV-less
authenticator holding a discoverable credential under `'preferred'` as well as
`'required'` — this app's sign-in sends no `allowCredentials` (see "Passkey
authentication options"), the likely reason, not isolated further. No browser
test can therefore tell the two values apart at sign-in, and the authentication
options' `'required'` is pinned only by the unit tests in
`src/lib/auth/passkey.test.ts`. A physical key may behave differently.

Nobody who could use a passkey before is affected: the server already demanded
verification, so every stored credential was registered with it and every
successful sign-in supplied it.

Rejected:

- **Accept possession alone** (`requireUserVerification: false`). A PIN-less
  key would work, but a stolen key would become a full sign-in for any
  authenticator that skips verification — a looser posture for everyone, to
  rescue a population that has the magic link to fall back on.
- **Split by ceremony** (presence for registration, verification for sign-in).
  A key registered without verification could then never sign in.

### Passkey challenge store

`src/lib/auth/passkey.ts` keeps WebAuthn challenges in memory, one bounded
partition per `ChallengePurpose`: `registration` (1,000) and `authentication`
(10,000).

They are separate because their writers differ in trust. Registration is
session-gated and keys by `accountId`; authentication is unauthenticated and
keys by a server-generated random id. One shared map would let a flood on the
ungated side evict the gated side's entries, and would let
`authenticate/verify`'s caller-supplied `challengeId` reach a registration
challenge — consuming a victim's in-flight one if their `accountId` were known.

Sizing: roughly 200 B per entry (32 B key, 43 B base64url challenge, 8 B
timestamp, ~120 B Map and object overhead), so both partitions full is about
2.2 MB against the 2 GB VPS. `registration`'s ceiling is a backstop rather than
a working limit — that partition holds at most one entry per account with a
registration in flight.

**Ordering invariant:** within a partition, iteration order is non-decreasing
in `expiresAt`. It holds because the TTL is constant, `expiresAt` is never
refreshed on read, and `storeChallenge` deletes a key before re-inserting it so
a re-stored entry moves to the tail. Two things depend on it: cleanup walks
from the head and stops at the first live entry (complete, not a sample), and
the head is the correct eviction victim under capacity pressure.

### Session Management

Sessions are stored in the database (not JWTs) so they can be revoked. Session cookie points to a session record with `expires_at`. Middleware checks session validity on every authenticated request.

### Session-issuing doors

Every site that mints a session cookie also clears the signup-ticket cookie:
a browser holding a session has no use for a ticket, and the profile routes
will not read one while a session cookie is present (`ticketTokenFrom`,
`src/lib/auth/profile-authorization.ts`).

Re-derive the roster with:

```sh
grep -rl "setSessionCookie" src --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | grep -v 'src/lib/auth/session.ts'
```

Five at the time of writing: `magic-link/verify`, `magic-link/claim`,
`passkey/authenticate/verify`, and the ticket paths of `teacher-profile` and
`student-profile`.

Two things about that command, both learned by getting it wrong. It matches
the bare name rather than `setSessionCookie(`, so a wrapped or reformatted
call still counts; and it searches `src`, not `src/app`, so a door added
outside the route tree cannot hide. `src/lib/auth/session.ts` is excluded
because it defines the helper rather than using it. Cross-check against

```sh
grep -rl "createSession(" src --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | grep -v 'src/lib/auth/session.ts'
```

which should name the same five files. The two are 1:1 today, and a
divergence is itself the signal that a door was added or lost.

The one door that ends a session rather than issuing one is the ticket-minting
branch of `magic-link/verify` and `magic-link/claim`: minting a ticket clears
AND revokes any session the request carried, because the precedence rule below
would otherwise leave the new ticket unusable for its whole life.

### The signup-ticket precedence rule

A signup ticket is readable only when the request carries no session cookie —
presence, not validity. `ticketTokenFrom` (`src/lib/auth/profile-authorization.ts`)
is the only place that decision is spelled; everything else calls it. Four
callers at the time of writing: the two resolvers in that same module (serving
`POST /api/account/teacher-profile` and `POST /api/account/student-profile`),
and the two server-rendered pages that prefill a form from a ticket —
`/signup/profile` and the booking page. Re-derive with:

```sh
grep -rn "ticketTokenFrom(" src --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.'
```

A page that re-derived the rule from `getSession()` instead would be subtly
wrong in the same way twice over: `getSession()` is falsy both when no session
cookie was sent and when one was sent but failed to validate, and only the
first of those may fall back to a ticket.

Presence has one definition because one parser answers it. `getSessionToken`
reads `NextRequest.cookies`, the same store `ticketTokenFrom` asks; a second,
hand-rolled `Cookie`-header split used to disagree with it about headers the
platform parser refuses.

---

## Database

### PostgreSQL Configuration

Single PostgreSQL instance alongside the Next.js application. For a donation-funded app serving independent yoga teachers, this handles significant load before needing to scale.

**Estimated capacity on a 2GB VPS:** ~500 active teachers with their students comfortably. PostgreSQL connection pooling via Prisma. The main query patterns (class list for a teacher, registrations for a class, notifications for a user) are all simple indexed lookups.

### Key Indexes

```sql
-- Teacher schedule view (most frequent query). On "CalendarEntry" since
-- issue 327: both class families share one calendar table.
CREATE INDEX "CalendarEntry_teacherId_date_idx" ON "CalendarEntry" ("teacherId", date);

-- Student's upcoming bookings
CREATE INDEX idx_registration_student_status ON "Registration" (student_id, status);

-- Notification inbox
CREATE INDEX idx_notification_recipient ON "Notification" (recipient_type, recipient_id, is_read);

-- Waitlist processing
CREATE INDEX idx_waitlist_class_position ON "WaitlistEntry" (class_id, position);

-- Payment tracking
CREATE INDEX idx_payment_status ON "Payment" (status, created_at);
```

### Migrations

Prisma handles migrations. Every schema change produces a migration file that's committed to git. Migrations run automatically on deployment.

#### What the drift check enforces

CI's `Check schema/migration drift` step runs `prisma migrate diff
--from-schema-datasource … --to-schema-datamodel … --exit-code` against a
database built by `migrate deploy`. It was added to catch a schema edit
committed without a migration, and it does. What it enforces is wider, and
that is a decision this project made (#329), not an accident of the tool:

> **Everything Prisma can model must be declarable in `prisma/schema.prisma`.**

Every hand-authored database object falls into one of three categories:

1. **Declarable.** Prisma models it and the schema can say so.
   `CalendarEntry.span` and `ScheduleRule.slot` are `Unsupported(...)` with
   `@default(dbgenerated())`: declared, so the two sides agree.
2. **Invisible.** Prisma does not model it, so the diff never sees it:
   every `CHECK`, every `EXCLUDE USING gist` constraint, every trigger and
   trigger function, and every partial or expression unique index
   (`Room_private_identity_unique`, `WaitlistEntry_waiting_position_key`).
   The same goes for an attribute Prisma does not read on an object it does:
   `DEFERRABLE INITIALLY DEFERRED` on a declared foreign key passes the
   check. These pass because Prisma cannot see them, which says nothing
   about whether they are right. The evidence for them is the tests that
   exercise them, and the seed step that runs right after the drift step.
3. **Visible but not declarable.** Prisma models the kind of object but the
   schema language cannot express the variant. The first case was #328's
   composite foreign key with PostgreSQL 15's column-list
   `ON DELETE SET NULL ("scheduleRuleId")`. **Such an object fails the
   check, and this repo does not ship one.**

Which category an object falls in is a fact about the pinned Prisma
version, not about PostgreSQL, so measure it rather than guess: apply the
object to a migrated scratch database and run the step's command against
it. Guesses have been wrong in both directions. #329 expected
`ON DELETE SET DEFAULT` and a `DEFERRABLE` foreign key to be category 3,
but the first is declarable (`onDelete: SetDefault`) and the second is
invisible. A Prisma upgrade can move an object between categories.

`20260829120000_entry_rule_kind_guard`'s header gives a different reason
the composite key was not used: that `ON DELETE SET NULL` would null every
referencing column, `kind` included. The column-list form above removes
that reason, and what remains is this check. The correction is recorded
here because the migration file is immutable.

**Why the check is not narrowed to its original purpose.** A
category-3 object and a genuinely unmigrated schema edit produce the same
diff. Measured on #329: #328's column-list foreign key applied to a
migrated database, and separately an `onDelete` change made in the schema
with no migration, each yield a `DropForeignKey` plus `AddForeignKey` hunk
on `CalendarEntry_scheduleRuleId_fkey` and exit 2. Nothing in the output
tells intent apart, so narrowing means allowlisting one constraint's exact
diff text: a frozen string that rots silently and weakens the check for
the whole repo to serve one object.

**The way out is category 2, and it has a price.** Express the rule as a
trigger instead, as `20260829120000_entry_rule_kind_guard` did for #328.
`CREATE CONSTRAINT TRIGGER … DEFERRABLE` is the form for a check that
must run at commit. A trigger standing in for
a foreign key does not get a foreign key's `FOR KEY SHARE` lock on the
referenced row, so its behaviour under concurrent writes has to be argued
rather than inherited. #328's argument is its second trigger:
`ScheduleRule.kind` is immutable, so the guard's unlocked read of it cannot
go stale, and the single-column foreign key still guarantees the row exists.
That argument is stated in the migration's own header. A new one belongs in
`docs/lock-order.md`, beside the lock arguments already there.

**When to revisit:** a category-3 object with no category-2 equivalent that
can be argued safe under concurrent writes. That is a concrete case to
measure a narrower check against, and it has not happened yet.

---

## Real-Time Updates

Server-Sent Events (SSE) for real-time notifications. Simpler than WebSockets, works through most proxies, and is sufficient for one-directional server-to-client updates (which is all we need — notifications flowing to the user).

```typescript
// API route: /api/notifications/stream
export async function GET(request: Request) {
  const session = await getSession(request);

  const stream = new ReadableStream({
    start(controller) {
      // Subscribe for whichever profiles the account holds — a dual-role
      // account hears both its teacher and student notifications.
      const unsubscribe = subscribeToNotifications(
        { teacherId: session.teacherId, studentId: session.studentId },
        (notification) => {
          controller.enqueue(`data: ${JSON.stringify(notification)}\n\n`);
        }
      );

      request.signal.addEventListener('abort', unsubscribe);
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}
```

---

## Cron Jobs

Every job skips a tick while its own previous run is still in flight, and from the second refused tick on it reads unhealthy (`STALLED_AFTER_SKIPPED_TICKS`, `src/lib/scheduler.ts`); Overlapping triggers, below, records which jobs were examined for a manual call overlapping a scheduled tick — a job it does not name was not examined. Each job's first run happens shortly after the Node server boots (15 seconds after the scheduler registers it, or one interval after it when the interval is no longer than that, as for the 10-second push job, which gets no separate 15-second run), then on its own `setInterval` (`src/lib/scheduler.ts`, wired from `instrumentation.ts`). The `/api/cron/*` endpoints remain for manual runs alongside the scheduler: `ls src/app/api/cron` lists them, and a job in the table below with no directory there — waitlist reconciliation and push dispatch — runs only on the scheduler. `CRON_SCHEDULER=off` is a CI setting, not a production mode (`DEPLOYMENT.md` §5).

| Job | Schedule | What it does |
|---|---|---|
| Class transitions | Every minute | Advances open → in_progress, auto-cancels classes below min_students, auto-completes classes 15 minutes after their end |
| Email fallback | Every 5 minutes | Sends email for unread notifications older than 30 minutes, or on the next sweep regardless of age for a waitlist promotion |
| Class generation | Every hour | Extends recurring class and studio-class instances on the rolling 4-week window |
| Payment reminders | Every hour | Flips pending payments to overdue after 7 days, then reminds on overdue payments not reminded in the last 7 days |
| Class reminders | Every 5 minutes | Reminds registered students and the teacher of an open class at each one's chosen moment (`reminderMoment`, `src/lib/reminder-moment.ts`), in the inbox and/or by direct email — once, and never at or after the class's start |
| Daily cleanup | Daily | Purges expired sessions and auth tokens, reaps closed waitlist entries past retention, deletes notifications past their type's retention period (`NOTIFICATION_RETENTION_DAYS`, `src/lib/notification-retention.ts`), deletes push subscriptions unused past `PUSH_SUBSCRIPTION_RETENTION_DAYS` (`src/services/push-subscription-retention.ts`), emails the operator the degradation events that are new or have fired again, and audits stored teacher timezones — failing the job if any teacher's zone is unresolvable or an offset identifier (`isValidTimeZone`) |
| Waitlist reconciliation | Every minute | Re-checks waitlists against freed seats — auto-promotes the next in queue, or broadcasts a first-come claim in the final hour before class start |
| Push dispatch | Every 10 seconds | Reads committed `Notification` rows with `pushHandledAt: null`, sends to the recipient's subscribed devices where preference allows, and retires (stamps `pushHandledAt` without sending) any row already older than `PUSH_STALE_AFTER_MS` (15 minutes) when this sweep reads it (`src/services/push-dispatch.ts`); a tick that retired a row, had a send come back `failed`, `gone` or `invalid`, or claimed rows it could not send (`unsendable`: `VAPID_*` is set but unusable) logs one `info` line with the tick's counts, and a tick that throws logs it too, with `faulted: true`, before rethrowing, so the rows it retired and the sends that happened before the fault leave a trace. **Tick bound:** four workers each claim a notification just before sending it, in parallel across its devices, and stop claiming `PUSH_CLAIM_DEADLINE_MS` (10 s) into the tick, so a tick ends within one send timeout (`DEFAULT_TIMEOUT_MS`, 5 s) of that: about 15 s plus the DB calls a worker makes after its last deadline check (the 5 s margin below the 20 s stall line absorbs them), under the 20 s that `STALLED_AFTER_SKIPPED_TICKS` (2) × the 10 s interval allows. A timeout burst of any size therefore stays healthy on the steady 10 s grid (the push job's first tick is the interval's, at 10 s; see Each job's first run above); the rows it did not reach are unclaimed and wait for the next tick (or are retired as stale after 15 minutes). `scheduler.test.ts` ("keeps a push tick shorter than the scheduler's stall line") re-derives the inequality from the constants. **Degraded:** a tick that tried to send and delivered nothing (`sent === 0` with `failed > 0`, or any tick, claimed rows or not, while `VAPID_*` is set but unusable: the result's `misconfigured` carries the reason on every tick, so a bad deployment alarms without waiting for a notification) extends a streak; a delivery resets it; idle ticks and `gone` / `invalid` verdicts leave it alone. A tick whose dispatch throws (a send fault, `PushSendFault`, or a claim or read failure inside a worker) counts as a failed tick whatever else it delivered, and the fault, not the alarm, is what that tick throws. A delivery resets the streak even from a tick that also failed elsewhere: the alarm says push is delivering nothing, not that every send succeeded. A failed tick more than 15 minutes (`PUSH_ALARM_QUIET_MS`) after the previous one starts the count over at one. At 3 such ticks the job throws `PushDispatchDegradedError`, whose message names the last failing tick's cause (the `VAPID_*` reason, failed sends, or the `name` of the fault that tick threw, which a quiet tick after it does not replace), and `/api/health` reports it degraded, on every tick until its last failed tick is 15 minutes old (`PUSH_ALARM_QUIET_MS`), then clears. Bound, measured from the start of the first failed tick: about 20 s of continuous fast failures (the 3rd failed tick starts 2 × 10 s later), at most 55 s when every send times out (ticks start 20 s apart because a 15 s tick refuses the next one); under sparse traffic it is the 3rd failed tick, provided each followed the last within 15 minutes, since a failed send cannot be observed without a send; a misconfiguration needs none, so it alarms on the 3rd tick after boot (the push job's first tick is one interval in, so about 30 s). While it stands the job logs one `error` per 10 s tick. A restart resets the streak. |

### Overlapping triggers

The jobs named in this section have had their send guarded at the DB layer
against a manual `/api/cron/*` call overlapping a scheduled tick, and were
measured:

- **Payment reminders** stamps `Payment.reminderSentAt` with a conditional
  `updateMany` inside a `$transaction` and abandons the notification when the
  count is zero (`payment-reminders.ts`).
- **Email fallback** claims each notification — `emailSent: false → true`,
  count checked — before calling Resend, and releases the claim if the send
  fails (`email-fallback.ts`).
- **Class reminders** claims each reminder with a conditional `updateMany` on
  its stamp (`Registration.classReminderSentAt`, `Class.teacherReminderSentAt`),
  count checked, before writing an inbox row or sending anything
  (`class-reminders.ts`).
- **The degradation digest** claims each due event with a conditional
  `updateMany` keyed on the `lastSeenAt` it read, count checked, before
  sending, and puts the claims back if anything from the first claim through
  the send fails (`degradation-digest.ts`; Degradation events, below).

That is a statement about the jobs it names, NOT a survey. Class transitions
also sends recipient-visible notifications — `autoCancelClasses` writes a
`class_cancelled` set (`class-transitions.ts`) and `autoCompleteClasses`
reaches `completeClass`'s `payment_request` set (`class-lifecycle.ts`) — and
neither was examined for this.

### Degradation events

A degradation is a place where the app substitutes or withholds a value because
data that should have been impossible turned up: a tier outside 1–5, a timezone
that will not resolve. The user sees a page that works; nobody sees that a
fallback ran. Such a site calls `logDegraded` (`src/lib/degradation.ts`), which
logs the message and the allowlisted context and records the event so the operator is told.
`docs/degradation-sites.md` holds the audit of which log sites qualify and why
the rest do not, and one runbook section per code.

- **Registry.** `DEGRADATION_CODES` (`src/lib/degradation-codes.ts`) names every
  code with its log level, a description and its allowed context keys. The
  `DegradationEvent` table keeps one row per code, not one per occurrence:
  `occurrences`, `firstSeenAt`, `lastSeenAt`, `lastNotifiedAt` and the latest
  `sample` (`docs/data-model.md`).
- **Allowlist.** The context a site passes is filtered to the code's
  `contextKeys`, and to strings (truncated) and finite numbers, at runtime as
  well as in the types. Keys hold ids, enums, numbers or a zone string,
  never anything a person typed, so the row and the email carry no personal
  data by construction.
- **Coalescing.** The log line is written on every occurrence; the database
  write is coalesced to at most one per code per `COALESCE_WINDOW_MS`. The
  first occurrence after a quiet window writes at once; later ones are held as
  a count plus the latest sample and written when the window ends, so the last
  occurrence before silence is never left unwritten while the process lives.
  The digest needs that trailing write: it tells the operator again only when
  `lastSeenAt` has moved past `lastNotifiedAt`, so an occurrence that never
  reached the row would never count as having fired again since they were
  told. The count is approximate by construction: what is held when the process
  exits is lost.
- **Digest.** A code is due when `lastNotifiedAt` is null or older than
  `lastSeenAt`. The `daily-cleanup` job (`notifyOperatorOfDegradations`,
  `src/services/degradation-digest.ts`) claims each due row with an
  `updateMany` conditional on the `lastSeenAt` it read, emails the claimed rows
  as one message, and if a claim, the render or the send fails puts back
  every claim made so far and throws, which flips the job unhealthy on the
  verdict `/api/health` already publishes. The sweep sits just before the
  timezone audit, which stays last (`src/lib/scheduler.ts`).
- **Why `lastNotifiedAt` takes the `lastSeenAt` value.** Stamping the clock
  would swallow an event that lands between the read and the stamp: its
  `lastSeenAt` would be older than the stamp and the row would look told.
  Stamping the value that was read leaves a later event ahead of the stamp, so
  that row is due again next run. For the same reason the claim's `where`
  names that value, so a newer event makes the claim count 0 and the row is
  left for the next run.
- **A failed release.** If putting a claim back fails, the event stays marked
  told without an email; `degradation-digest.ts` logs the code at `error` and
  throws. That is the same exposure as a crash between claim and send, which
  the claim-before-send design accepts: the alternative, sending before
  claiming, lets overlapping runs email the same event twice.
- **Unset `OPERATOR_EMAIL`.** The scheduler logs an `error` at boot in
  production. When an event is due and the address is unset, the digest logs
  the due codes at `error` and throws, so the job reads unhealthy on
  `/api/health` instead of the events sitting unseen; nothing is claimed.
- **Health.** `/api/health` reports `degradations.open`, the number of events
  whose `lastSeenAt` is within the last 24 hours, as a bare number. Which codes
  fired, and what they carried, appear only in the digest email and the server
  log, never on `/api/health`. When the count cannot be read, `degradations` is
  omitted and `db` still reports up.

---

## Deployment

### Single VPS Setup

```
┌─────────────────────────────────────────┐
│  VPS (2GB RAM, 1 vCPU)                  │
│                                         │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │   Nginx     │  │  Let's Encrypt   │  │
│  │  (reverse   │  │  (SSL certs)     │  │
│  │   proxy)    │  │                  │  │
│  └──────┬──────┘  └──────────────────┘  │
│         │                               │
│  ┌──────▼──────┐  ┌──────────────────┐  │
│  │  Next.js    │  │  PostgreSQL      │  │
│  │  (Docker)   │──│  (Docker)        │  │
│  │  Port 3000  │  │  Port 5432       │  │
│  └─────────────┘  └──────────────────┘  │
│                                         │
│  ┌─────────────────────────────────────┐│
│  │  Backups: daily pg_dump to S3/B2   ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

### Rate limiting

`src/lib/rate-limit.ts` is an in-memory sliding-log limiter. Buckets are partitioned by key prefix (`PREFIX_CAPACITIES`, each keyed via `rateLimitKey()` off a `RateLimitPrefix` literal), so a flood on one prefix can never evict or throttle-suppress another prefix's state — including between the IP- and email-keyed sub-buckets of the *same* route, which are separate prefixes (`magic-link:ip` vs `magic-link:email`, `student-signup:ip` vs `student-signup:email`) for the same reason.

**Client IP trust boundary.** `clientIp()` reads the LAST entry of `x-forwarded-for`, trusting exactly one proxy hop. This is only correct because `deploy/nginx.conf.example` sets `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, which appends the real client address (`$remote_addr`, as nginx sees it) to whatever the client sent — so the last entry is always nginx's own observation, and anything before it is client-controlled. Reading the first entry would trust that client-controlled prefix and let a caller spoof any IP for rate-limit purposes. If a second hop (a CDN, a load balancer) is ever added in front of nginx, this assumption needs re-deriving: the last entry would then belong to that hop, not the real client.

When `clientIp()` can't resolve any address at all (`x-forwarded-for` and `x-real-ip` both absent), the request is *not* exempted from its IP-keyed check — `checkIpRateLimit` routes it into one bucket shared by every such caller instead (`UNRESOLVED_IP_ID`), and logs a throttled warning, so an operator learns the trusted-proxy assumption above has broken rather than the check silently vanishing. Under normal operation (nginx configured as documented) this path never fires.

### docker-compose.yml (production)

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://yoga:${DB_PASSWORD}@db:5432/ethical_yoga
      - RESEND_API_KEY=${RESEND_API_KEY}
      - OPERATOR_EMAIL=${OPERATOR_EMAIL}
    depends_on:
      - db
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=ethical_yoga
      - POSTGRES_USER=yoga
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    restart: unless-stopped

volumes:
  pgdata:
```

### CI/CD

GitHub Actions runs on every PR:

```yaml
# .github/workflows/ci.yml
- TypeScript type checking (tsc --noEmit)
- Linting (eslint)
- Unit + integration tests (vitest)
- E2E tests (playwright against test database)
- Build verification (next build)
```

Main branch deploys automatically to VPS via SSH + Docker pull.

### Visual baselines, and the change that renders nothing

`check-visual-baseline-freshness` flags a route whose source file moved in this
diff while its screenshot did not — usually someone forgot
`pnpm exec playwright test visual --update-snapshots`.

Sometimes the edit genuinely does not render: a predicate extracted into a
shared module, an import reordered. Then the regenerated screenshot is
byte-identical, git has nothing to record, and the route **cannot clear on its
own** — the check compares a diff, and there is no diff to find.

That case is settled by an attestation in
`tests/e2e/visual-baseline-attestations.json`: a maintainer's record that one
exact source and one exact baseline were verified to render the same. Write it
with `pnpm run attest-visual-baseline <route> ["why"]`, which refuses unless
it can earn the claim — it reruns the whole visual suite itself and aborts if
a single baseline byte moved, because a change that moved a pixel needs its new
screenshot committed, not a note saying it didn't.

The record is two content hashes, not a route name, so it self-invalidates:
edit the source again and `sourceSha256` stops matching; regenerate the
baseline for real and `baselineSha256` does. It can never become a standing
exemption for a route, only for the pairing someone actually checked. An
allowlist entry or a `SKIP_VISUAL=1` would silence the route forever and leave
no trace of why.

Baselines are macOS-only (every file is `-darwin.png`), so the command refuses
to run anywhere else: a Linux digest would attest to bytes CI never renders.

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://yoga:password@localhost:5432/ethical_yoga

# Auth
PASSKEY_RP_ID=              # Relying party ID for WebAuthn (e.g. "ethicalyoga.app")
PASSKEY_RP_NAME=            # Display name (e.g. "Ethical Yoga")

# Email
RESEND_API_KEY=             # Transactional email
OPERATOR_EMAIL=             # Receives the daily degradation digest
EMAIL_FROM=                 # e.g. "noreply@ethicalyoga.app"

# Payments (Level 2, added later)
MOLLIE_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Push — generate with `pnpm run vapid:keys`. Unset disables push. Rotating
# the pair silently orphans every existing subscription — browsers
# re-subscribe only when the user turns push on again.
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=              # a mailto: or https:// URL, e.g. "mailto:ops@fair.yoga"

# App
NEXT_PUBLIC_APP_URL=        # e.g. "https://ethicalyoga.app"
```

---

## What's Intentionally Left Out

These are deferred, not forgotten:

- **Native mobile app.** The teacher dashboard is mobile-first responsive web. If native is needed later, the services layer can be extracted into a standalone API.
- **Multi-language / i18n.** English first. Next.js has built-in i18n routing for when we add languages.
- **Rate limiting / abuse prevention.** Needed before public launch, but not for initial development.
- **Log-based monitoring / observability.** A fallback that substitutes a value is recorded as a `DegradationEvent` row by `logDegraded` and emailed to `OPERATOR_EMAIL` in a daily digest, and `/api/health` carries the aggregate (Cron Jobs → Degradation events). Every other log line stays on stdout. A log backend (Grafana/Loki or similar) remains deferred until logs leave the box. Errors logged through `@/lib/log` are allowlisted (`src/lib/log-serializers.ts`, #739): every `Error` at the top level of a log call's first argument, any error-like value under `err`, and the `msg` pino falls back to; a value that cannot be serialized is replaced by a placeholder, never logged raw. Only named fields survive, and a cause appears under `err.cause` rather than folded into the message. A Prisma query error's message is withheld, since it renders row values; any other error's message is kept as written. Shipping logs still needs the rest of the stdout stream accounted for. Next prints an error a page or route throws outside `withErrorHandler` through `console.error`, with its message, stack, enumerable properties and cause chain; an `onRequestError` hook in `src/instrumentation.ts` would run beside that print, not instead of it, so that stream needs handling outside the app. Third-party text the app copies into its own messages is kept verbatim: Resend's error message inside `lib/email.ts`'s errors, `reason: error.message` strings, the push failure `cause` string `lib/push/send.ts` builds, and the push service's response body. Values copied out of an error into sibling keys (`rawTarget: err.meta?.target`) bypass the allowlist. An error nested below the top level of a log object, passed in the message position, passed as a format argument, or bound with `log.child` under any key but `err` is written by pino as its own enumerable properties, without the allowlist. And dry-run email mode logs recipient addresses, magic links and invitation sign-in URLs.
- **GDPR tooling.** Data export and account deletion endpoints. Required before launch, designed later.
- **Level 2 payment retry logic.** Open question — parked for now.
