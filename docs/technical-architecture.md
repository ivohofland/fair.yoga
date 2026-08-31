# Technical Architecture — Ethical Yoga App

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 14+ (App Router) | Single process handles SSR for public pages, SPA for teacher dashboard, and API routes. Low VPS footprint. |
| Language | TypeScript (strict mode) | `strict: true` in tsconfig. No `any`, no implicit types. Catches bugs at compile time, makes volunteer contributions safer. |
| Database | PostgreSQL | Relational model fits the data perfectly (see data-model.md). Mature, free, low resource usage. |
| ORM | Prisma | Type-safe queries generated from schema. Strict TypeScript integration. Easy for volunteers to understand. |
| Auth | Custom (magic link + passkeys) | Magic links via email. WebAuthn/passkeys for returning users. No passwords, no SMS (cost). Uses `oslo/crypto` for token generation and `@simplewebauthn/server` for passkey verification. |
| Email | Resend | Transactional email for magic links, payment reminders, notification fallback. Simple API, generous free tier. |
| Payments | Mollie (EU) / Stripe (US) | Level 1 doesn't need these (manual tracking). Level 2 uses payment links — no card-on-file, no subscriptions. |
| Styling | Tailwind CSS | Utility-first, matches the warm minimalist design brief. No custom CSS files to maintain. |
| Testing | Vitest + Playwright | Vitest for the projects in `vitest.config.ts`, Playwright for e2e. Test-first development — tests are written before implementation. The database-backed unit tiers run against a dedicated `ethical_yoga_test` database, auto-provisioned via `DATABASE_URL_TEST` (see `docs/test-database.md`). |
| Deployment | Single VPS (Docker) | One container running Next.js. PostgreSQL alongside or managed. Nginx reverse proxy. SSL via Let's Encrypt. |

## Development Approach

**Test-first development.** Every feature starts with a failing test. The cycle is: write test → see it fail → implement → see it pass → refactor. This applies at all levels — unit tests for the pricing engine, integration tests for API routes, e2e tests for critical user flows. No PR is merged without passing tests covering the change.

**TypeScript strict mode.** The tsconfig enforces `strict: true`, which enables `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, and all other strict flags. This is non-negotiable. For an open-source project with volunteer contributors, the compiler is the first line of defense against bugs.

### Testing conventions

**Shared fixtures.** `tests/helpers.ts` owns the *mechanical* layer most test files used to hand-roll: `BASE_URL`, `hashToken`, `cookie(token)`, `sessionCookie(token)`, `uniqueSuffix()`, `freshIp()`, and `seedSession(db, accountId)`. `freshIp()` returns an `{ 'x-forwarded-for': '10.a.b.c' }` header object that is unique per call, so every request to an IP-rate-limited route lands in a bucket nothing else has touched — that is what makes the integration suite re-runnable within the hour. It's shared by both the vitest integration suite (`tests/integration/*.test.ts`) and the Playwright e2e suite (`tests/e2e/*.spec.ts`): the module imports nothing from vitest and takes `PrismaClient` as a parameter, so it's usable from Playwright as-is. `cookie()` returns a header object for the integration suite's raw `fetch` calls; `sessionCookie()` is its Playwright-shaped counterpart, for `context.addCookies([...])`. Semantic fixtures — which class is open, which payment is pending, what a teacher's rates are — stay in each test file so a test's setup is readable where it is used. There is deliberately no `makeTeacherWithSession`-style wrapper: `classes-api.test.ts` and `payments-api.test.ts` each keep their own local `makeTeacher(tag)` rather than share one, and the two differ in `firstName`, `bio`, and the email/slug prefix — a shared version would need those as parameters, and the interesting values would vanish behind a helper call for every future caller. A test needing a non-standard session (an already-expired one, say) creates it inline instead of bending the helper: `auth.test.ts`'s expired-session test calls the production `createSession`, then `prisma.session.update`s the row's `expiresAt` into the past.

**What earns an HTTP guard test.** `requireTeacher`/`requireSession` are the same code on ~40 routes, so a 401/403 ladder per route re-tests one helper forty times. Test the shared guard helpers **once** — that coverage lives in `src/lib/api-utils.test.ts` (401 paths for `requireSession`, 403 + happy paths for `requireTeacher`/`requireStudent`, and `withErrorHandler`'s logging and status classification); a route earns its own HTTP guard test only when its authorization is **bespoke** (its own ownership chain or state guard) or when it carries a **business invariant**. Several route tests keep a ride-along 401 case alongside their bespoke ones, which is fine — what the rule forbids is a full 401/403 ladder on a route whose only guard is the shared one.

**What earns a component test.** The `components` Vitest project (jsdom, `src/components/**/*.test.tsx`, mocking `fetch` and `next/navigation` — no database) exists for wiring a pure function cannot reach: a URL assembled inline beside the label it must agree with, an element that only appears once rendered, a branch that only shows up in the DOM. A component earns a file for that reason and no other. A component whose logic already lives in a tested pure function, or which renders without branching, does not need one — an empty jsdom project is not an invitation to backfill coverage that already exists elsewhere.

**Rate-limited auth routes.** `POST /api/teachers` (IP-keyed, 3/hour) and `POST /api/auth/student-signup` (IP-keyed 5/hour, plus an unconditional per-email bucket at 3/15 min) are covered at the HTTP layer, in `signup-api.test.ts`. Repeated local runs used to exhaust those limiters, which made that file the first to fail on a re-run within the same hour; every such call now carries its own `freshIp()` address, so the IP buckets no longer accumulate across runs. The one test in that file that *does* reuse an address is the per-IP budget test, which is the only coverage `student-signup`'s IP limiter has — it deliberately burns one throwaway bucket to 6. `POST /api/auth/magic-link/send` is covered too, in `auth-email-case.test.ts`'s IP-short-circuit test: it deliberately spends both the IP bucket (10 hits from one throwaway address) and, in the same run, the target email's 3/15min bucket, so this route no longer needs a wait-or-trip tradeoff. When any of these three routes can't resolve a caller's IP, the check is not skipped — see the "Rate limiting" section for the shared-bucket degrade and its throttled warning log. We do not add a test-mode bypass to production code for test convenience.

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
│   │   ├── notifications.ts   # Three-layer notification dispatch
│   │   ├── notifications.test.ts
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
// in_progress → completed: when teacher marks class as done (or auto after duration)
// completed triggers:      pricing calculation → payment creation → notifications
//
// Not a transition: cancellation. `auto_cancel_check` firing below minStudents
// writes `cancelledAt` on the entry and leaves `status` alone.
```

### Waitlist (`services/waitlist.ts`)

Implements the hybrid promotion model:

```typescript
// More than 1h before cancel_deadline: auto-promote the queue head
// Final hour BEFORE the deadline: first-come-first-claimed broadcast
// At or after the deadline: frozen — nothing happens
async function handleSpotFreed(db, classId, now?): Promise<SpotFreedResult> {
  const cls = await db.class.findUnique({
    where: { id: classId }, include: { calendarEntry: true }, ...
  });
  // Liveness is TWO reads since #327: the status, and the entry's cancelledAt.
  if (!cls || cls.status !== 'open' || cls.calendarEntry.cancelledAt !== null) {
    return { action: 'none' };
  }

  const window = getWaitlistWindow(
    cls.calendarEntry.date, cls.calendarEntry.startTime, cls.cancelDeadline, tz, now,
  );
  if (window === 'frozen') return { action: 'frozen' };

  if (window === 'auto_promote') {
    // promoteNext: under the Class row lock, checks capacity, promotes the head
    return ...;
  }

  // first_come_first_claimed: under the Class row lock, counts free seats
  // (#212 — it used to notify without checking), then notifies everyone
  // waiting. The first claim wins; claimSpot re-checks capacity.
  return ...;
}
```

### Notification Dispatcher (`services/notifications.ts`)

Three-layer delivery:

```typescript
async function dispatch(notification: CreateNotification): Promise<void> {
  // Layer 1: Create in-app notification record (always)
  await createNotificationRecord(notification);

  // Layer 2: Push to real-time channel if recipient is online
  // (WebSocket or Server-Sent Events)
  await pushRealTime(notification);

  // Layer 3: Schedule email fallback
  // If not read within 30 minutes, send email
  await scheduleEmailFallback(notification, { delayMinutes: 30 });
}
```

### Entry Generator (`services/entry-generation.ts`)

Runs hourly as part of the in-process scheduler (see Background Jobs below). For each template whose `ScheduleRule` is active and unarchived it tops up the rolling 4-week window — **at most one entry per week per template** (#194) — and reports every candidate date it could **not** fill along with the reason:

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

```
1. User enters email on /login
2. API generates a signed token (oslo/crypto), stores hash in DB with 15-min expiry
3. Resend delivers email with link to /verify?token=xxx
4. /verify validates token, creates session cookie (httpOnly, secure, sameSite)
5. Redirect to dashboard (teacher) or bookings (student)
```

### Passkey (returning users)

```
1. User clicks "Sign in with passkey" on /login
2. Browser triggers WebAuthn ceremony via @simplewebauthn/browser
3. Server validates assertion via @simplewebauthn/server
4. Creates session cookie, same as magic link flow
5. Redirect to dashboard
```

### Session Management

Sessions are stored in the database (not JWTs) so they can be revoked. Session cookie points to a session record with `expires_at`. Middleware checks session validity on every authenticated request.

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

Five idempotent jobs run in-process on `setInterval`, started once when the Node server boots (`src/lib/scheduler.ts`, wired from `instrumentation.ts`). The `/api/cron/*` endpoints remain for manual runs and external schedulers.

| Job | Schedule | What it does |
|---|---|---|
| Class transitions | Every minute | Advances open → in_progress, auto-cancels classes below min_students, auto-completes finished ones |
| Email fallback | Every 5 minutes | Sends email for unread notifications older than 30 minutes |
| Class generation | Every hour | Extends recurring class and studio-class instances on the rolling 4-week window |
| Payment reminders | Every hour | Flips pending payments to overdue after 7 days, then reminds on overdue payments not reminded in the last 7 days |
| Auth cleanup | Daily | Purges expired sessions and auth tokens |

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
      - MAGIC_LINK_SECRET=${MAGIC_LINK_SECRET}
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

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://yoga:password@localhost:5432/ethical_yoga

# Auth
MAGIC_LINK_SECRET=          # For signing magic link tokens
PASSKEY_RP_ID=              # Relying party ID for WebAuthn (e.g. "ethicalyoga.app")
PASSKEY_RP_NAME=            # Display name (e.g. "Ethical Yoga")

# Email
RESEND_API_KEY=             # Transactional email
EMAIL_FROM=                 # e.g. "noreply@ethicalyoga.app"

# Payments (Level 2, added later)
MOLLIE_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# App
NEXT_PUBLIC_APP_URL=        # e.g. "https://ethicalyoga.app"
```

---

## What's Intentionally Left Out

These are deferred, not forgotten:

- **Native mobile app.** The teacher dashboard is mobile-first responsive web. If native is needed later, the services layer can be extracted into a standalone API.
- **Multi-language / i18n.** English first. Next.js has built-in i18n routing for when we add languages.
- **Rate limiting / abuse prevention.** Needed before public launch, but not for initial development.
- **Monitoring / observability.** Simple logging first, structured observability (Grafana/Loki or similar) added when there's something to monitor.
- **GDPR tooling.** Data export and account deletion endpoints. Required before launch, designed later.
- **Level 2 payment retry logic.** Open question — parked for now.
