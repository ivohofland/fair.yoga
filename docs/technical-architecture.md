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
| Testing | Vitest + Playwright | Vitest for unit/integration, Playwright for e2e. Test-first development — tests are written before implementation. The vitest unit tier runs against a dedicated `ethical_yoga_test` database, auto-provisioned via `DATABASE_URL_TEST` (see `docs/test-database.md`). |
| Deployment | Single VPS (Docker) | One container running Next.js. PostgreSQL alongside or managed. Nginx reverse proxy. SSL via Let's Encrypt. |

## Development Approach

**Test-first development.** Every feature starts with a failing test. The cycle is: write test → see it fail → implement → see it pass → refactor. This applies at all levels — unit tests for the pricing engine, integration tests for API routes, e2e tests for critical user flows. No PR is merged without passing tests covering the change.

**TypeScript strict mode.** The tsconfig enforces `strict: true`, which enables `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, and all other strict flags. This is non-negotiable. For an open-source project with volunteer contributors, the compiler is the first line of defense against bugs.

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
│   │   └── class-generator.ts # Rolling 4-week instance generation
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
interface PricingInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  registrations: Array<{ tierAtBooking: number }>; // 1-5
}

interface PricingOutput {
  effectiveTeacherRate: number;
  totalRevenue: number;
  studentPrices: Array<{
    tier: number;
    price: number;
    tierRatio: number;
  }>;
}

function calculatePricing(input: PricingInput): PricingOutput {
  // Step 1: Calculate effective teacher rate
  //   Linear interpolation between minRate and targetRate
  //   based on registration count between minStudents and maxStudents

  // Step 2: Calculate total class cost
  //   roomCost + effectiveTeacherRate (teacher rate is per-class, not per-student)

  // Step 3: Distribute across tiers using compressed spread
  //   Tier ratios: [0.65, 0.80, 1.00, 1.20, 1.35]
  //   Each student's share = totalCost × (theirRatio / sumOfAllRatios)

  // Step 4: Return per-student prices
}
```

This function is pure — no side effects, no database calls. It's the most tested code in the system.

### Class Lifecycle (`services/class-lifecycle.ts`)

Manages the class state machine:

```
draft → open → full → in_progress → completed → cancelled
```

```typescript
interface ClassTransition {
  from: ClassStatus;
  to: ClassStatus;
  guard: (classData: Class) => boolean;
  onTransition: (classData: Class) => Promise<void>;
}

// Key transitions:
// open → full:          when registrations reach maxStudents
// full → open:          when a student cancels and spots open
// open/full → cancelled: when auto_cancel_check fires and count < minStudents
// open/full → in_progress: when class start_time is reached
// in_progress → completed: when teacher marks class as done (or auto after duration)
// completed triggers:    pricing calculation → payment creation → notifications
```

### Waitlist (`services/waitlist.ts`)

Implements the hybrid promotion model:

```typescript
// Before cancel_deadline: auto-promote in queue order
// After cancel_deadline (final hour): first-come-first-claimed
async function processWaitlist(classId: string): Promise<void> {
  const classData = await getClass(classId);
  const now = new Date();
  const deadline = subHours(classData.startTime, deadlineHours(classData.cancelDeadline));

  if (now < deadline) {
    // Auto-promote: next person in queue gets the spot
    await autoPromoteNext(classId);
  } else {
    // First-come: notify all waitlisted, first to claim gets it
    await openSpotToAll(classId);
  }
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

### Class Generator (`services/class-generator.ts`)

Runs as a cron job (daily). For each active ClassTemplate, ensures instances exist for the next 4 weeks:

```typescript
async function generateUpcomingClasses(): Promise<void> {
  const templates = await getActiveTemplates();
  const horizon = addWeeks(new Date(), 4);

  for (const template of templates) {
    const existingDates = await getGeneratedDates(template.id);
    const missingDates = calculateMissingDates(template.dayOfWeek, horizon, existingDates);

    for (const date of missingDates) {
      await createClassFromTemplate(template, date);
    }
  }
}
```

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
-- Teacher schedule view (most frequent query)
CREATE INDEX idx_class_teacher_date ON "Class" (teacher_id, date);

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
      // Subscribe to notifications for this user
      const unsubscribe = subscribeToNotifications(
        session.userId,
        session.userType,
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

Two scheduled tasks running within the Next.js process (via `node-cron` or triggered by an external cron hitting an API endpoint):

| Job | Schedule | What it does |
|---|---|---|
| Class generator | Daily at 02:00 | Creates class instances for the next 4 weeks from active templates |
| Auto-cancel check | Every 15 minutes | Checks classes approaching their auto_cancel_check time, cancels if below min_students |
| Email fallback | Every 5 minutes | Sends email for unread notifications older than 30 minutes |
| Payment reminders | Daily at 10:00 | Sends reminder for pending payments older than 48 hours |

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
