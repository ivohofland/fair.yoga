# Implementation Plan — Ethical Yoga App

Built by Ivo + Claude Code. Technical foundation first, then layer on UI and features incrementally. Each phase produces something testable and buildable before the next one starts.

---

## Phase 1: Project Scaffolding & Data Layer

**Goal:** A running Next.js project with the full database schema, migrations, seed data, and CI pipeline. No UI yet — just the foundation everything else builds on.

**Tasks:**

1.1 — Initialize Next.js 14+ project with App Router, TypeScript strict mode, Tailwind CSS
1.2 — Configure tooling: ESLint, Prettier, Vitest, Playwright, tsconfig with `strict: true`
1.3 — Set up Docker Compose for local development (Next.js + PostgreSQL)
1.4 — Define Prisma schema from `data-model.md` — all 11 entities with relationships, enums, indexes
1.5 — Generate and verify initial migration
1.6 — Write seed script with realistic test data (2 teachers, 10 students, rooms, classes across lifecycle states, registrations with different tiers)
1.7 — Set up GitHub Actions CI: type check, lint, test, build
1.8 — Create project folder structure matching `technical-architecture.md`

**Done when:** `npm run dev` starts, Prisma Studio shows seeded data, CI passes on a clean push.

---

## Phase 2: Pricing Engine & Core Services

**Goal:** The business logic layer — pure TypeScript functions with comprehensive tests. No HTTP, no UI. This is the most critical code in the system and gets the most testing attention.

**Tasks:**

2.1 — Implement pricing engine (`services/pricing.ts`) with full test suite
  - Tier ratio calculation with compressed spread [0.65, 0.80, 1.00, 1.20, 1.35]
  - Effective teacher rate linear interpolation
  - Total class cost distribution across tiers
  - Edge cases: min_rate = target_rate (flat rate), negative min_rate, single student, all same tier, walk-ins exceeding max
  - Test against pricing-simulator.html values for validation

2.2 — Implement class lifecycle state machine (`services/class-lifecycle.ts`)
  - State transitions with guards: draft → open → full → in_progress → completed → cancelled
  - settings_locked enforcement on first registration
  - Transition side effects (pricing calculation on completion, notification triggers)

2.3 — Implement waitlist service (`services/waitlist.ts`)
  - Auto-promote (before deadline)
  - First-come-first-claimed (final hour)
  - Frozen after deadline
  - Position management (reorder on removal)

2.4 — Implement notification dispatcher (`services/notifications.ts`)
  - Create notification record
  - Email fallback scheduling logic
  - Notification types enum and templates

2.5 — Implement payment service (`services/payments.ts`)
  - Payment creation from completed class + pricing output
  - Status transitions: pending → paid / overdue
  - Reminder tracking

2.6 — Implement class generator (`services/class-generator.ts`)
  - Rolling 4-week instance generation from active templates
  - Idempotent (safe to run multiple times)

**Done when:** All services have passing test suites covering happy paths and edge cases. `npm test` shows green across the board.

---

## Phase 3: Authentication & API Routes

**Goal:** Working auth (magic link + passkeys) and API endpoints that expose the services layer over HTTP. Testable with curl or Postman.

**Tasks:**

3.1 — Implement magic link auth flow
  - Token generation with oslo/crypto
  - Email sending via Resend
  - Token verification and session creation
  - Session middleware for protected routes

3.2 — Implement session management
  - DB-stored sessions with expiry
  - Session cookie (httpOnly, secure, sameSite)
  - Session validation middleware
  - Logout (session deletion)

3.3 — Implement passkey registration and authentication
  - @simplewebauthn/server integration
  - Credential storage
  - WebAuthn ceremony endpoints

3.4 — Build API routes (thin wrappers around services)
  - `api/auth/*` — magic link, passkey, session
  - `api/classes/*` — CRUD, lifecycle transitions
  - `api/registrations/*` — book, cancel, walk-in
  - `api/payments/*` — mark paid, send reminder
  - `api/notifications/*` — list, mark read, SSE stream
  - `api/teachers/*` — profile, settings, defaults
  - `api/students/*` — profile, privacy settings
  - `api/rooms/*` — CRUD, library search
  - `api/announcements/*` — create, send

3.5 — Write integration tests for all API routes

3.6 — Implement SSE endpoint for real-time notifications

**Done when:** Full API working with auth. Integration tests pass. Can create a teacher, add a room, create a class, register a student, complete the class, and see calculated prices — all through API calls.

---

## Phase 4: Teacher Dashboard UI

**Goal:** The teacher-facing screens — mobile-first, functional, using the v2 design system's calm-utility aesthetic. This is where the app becomes usable.

**Tasks:**

4.1 — Build base UI components following `design-brief.md` (v2 design system)
  - Buttons (primary, secondary, destructive)
  - Cards (sand-soft, radius 16, border — no shadow)
  - Input fields, dropdowns, toggles
  - Bottom tab navigation (4 tabs)
  - Status badges, progress indicators
  - Typography: Georgia headings, system sans body (six type styles)
  - Color tokens from palette

4.2 — Build layout shell
  - Bottom tab bar (Schedule, Students, Inbox, Settings)
  - Auth-protected route group
  - Responsive container (mobile-first)

4.3 — Schedule tab
  - Week view with class cards (chronological list)
  - Class status indicators (registration progress bar)
  - Studio class entries in timeline
  - Create class button

4.4 — Class detail (adaptive screen)
  - Future state: settings summary, pricing preview, edit/share/cancel
  - Registering state: student list, tier distribution, estimated prices
  - Today state: attendance checklist, add walk-in
  - Completed state: pricing breakdown, payment checklist
  - Archived state: historical view

4.5 — Create class flow (stepped)
  - Step 1: Basics (room, date/time, type)
  - Step 2: Pricing (rate range, student range, live preview)
  - Step 3: Policies (cancellation, auto-cancel)
  - Confirmation

4.6 — Students tab
  - Student list (searchable)
  - Student detail (attendance history, payment history, shared info)
  - Add student / CRM import

4.7 — Inbox tab
  - Notification list (chronological, read/unread)
  - Tap to navigate to relevant context

4.8 — Settings tab
  - Profile editing (name, photo, bio, page slug)
  - Room management (list, add, edit overrides)
  - Payment settings (bank details, processor connection placeholder)
  - Defaults (currency, timezone, reminders)
  - Notification preferences

4.9 — Modals and overlays
  - Log studio class (quick entry)
  - Add walk-in (search + confirm)
  - Share sheet
  - Send announcement
  - Cancel class confirmation

**Done when:** A teacher can sign up, set up their profile and room, create a class, see it on their schedule, and navigate all four tabs. Mobile-first, looks like the design brief.

---

## Phase 5: Student Experience & Public Pages

**Goal:** The student-facing side — booking page, registration flow, tier selection, payment view, and privacy settings.

**Tasks:**

5.1 — Teacher's public booking page (SSR)
  - Teacher profile (name, photo, bio)
  - Upcoming classes list with available spots
  - Class detail with estimated price range per tier
  - Book button → registration flow

5.2 — Student registration / booking flow
  - First-time: account creation (name, email, magic link)
  - Tier selection with yogic framing (placeholder copy)
  - Tier 1/2 gentle confirmation prompt
  - Booking confirmation

5.3 — Student dashboard
  - Upcoming bookings list
  - Past classes with payment status
  - Open payments view

5.4 — Student settings
  - Privacy settings per teacher (share email, phone, birthday, address)
  - Reminder preferences (morning-of, evening before, 1h, off)
  - Email notifications on/off
  - Tier change

5.5 — Payment views (student side)
  - Level 1: bank details display, EPC QR code, copy payment details
  - Open payment reminders

5.6 — Waitlist experience
  - Join waitlist indication
  - Promotion notification
  - First-come-first-claimed claim flow

**Done when:** A student can find a teacher's page, book a class, select their tier, see their price after class, and view payment instructions. Privacy settings work per teacher.

---

## Phase 6: Teacher Onboarding & Polish

**Goal:** The guided first-time experience, edge cases, and refinements that make the app feel complete.

**Tasks:**

6.1 — Onboarding overlay flow
  - 4-step guide: profile → room → class → share
  - Progress indicator
  - Steps use real screens (not a tutorial)
  - Disappears when complete

6.2 — Payment overview (cross-class)
  - All outstanding payments, filterable by class/student/date
  - Per-student outstanding balance

6.3 — Reporting
  - Total classes taught (independent + studio)
  - Total students reached
  - Income breakdown

6.4 — Cron jobs
  - Class generator (daily, rolling 4-week)
  - Auto-cancel check (every 15 min)
  - Email fallback (every 5 min)
  - Payment reminders (daily)

6.5 — Email templates
  - Magic link
  - Booking confirmation
  - Class cancellation
  - Payment request (Level 1)
  - Payment reminder
  - Waitlist promotion / spot available
  - Class reminder

6.6 — Custom domain support
  - DNS verification
  - SSL provisioning

6.7 — E2E test suite
  - Teacher onboarding flow
  - Class booking flow
  - Payment flow
  - Waitlist flow

**Done when:** A new teacher can go through the full onboarding, create recurring classes, have students book, complete a class, and track payments. All cron jobs running. E2E tests green.

---

## Phase 7: Deployment & Launch Prep

**Goal:** Production-ready deployment on a single VPS, with monitoring, backups, and the basics needed for real users.

**Tasks:**

7.1 — Production Dockerfile and docker-compose
7.2 — Nginx reverse proxy configuration
7.3 — Let's Encrypt SSL setup
7.4 — Database backup automation (daily pg_dump)
7.5 — Environment variable management
7.6 — Basic error logging and health checks
7.7 — Rate limiting on auth and API endpoints
7.8 — Security review (CSRF, XSS, injection)
7.9 — Transparent running costs page (Dana model)
7.10 — Landing page / marketing page

**Done when:** App is live on a VPS, accessible via domain, with SSL, backups, and basic security. Ready for first teachers.

---

## Phase 8: Level 2 Payments & Beyond

**Goal:** Integrated payment processing and features that come after initial user feedback.

**Tasks:**

8.1 — Mollie integration (EU — iDEAL, cards)
8.2 — Stripe integration (US/UK — cards)
8.3 — Payment webhooks and automatic status tracking
8.4 — Teacher payment dashboard with fee transparency
8.5 — Student data export (GDPR)
8.6 — Account deletion (GDPR)
8.7 — i18n preparation (Next.js routing, translation keys)
8.8 — Community contributions workflow (GitHub, issue templates, contribution guide)

**Done when:** Teachers can connect Mollie/Stripe and have payments processed automatically. GDPR tooling in place.

---

## Phase Summary

| Phase | Focus | Depends on |
|---|---|---|
| 1 | Scaffolding & data layer | — |
| 2 | Pricing engine & services | Phase 1 |
| 3 | Auth & API routes | Phase 1, 2 |
| 4 | Teacher dashboard UI | Phase 3 |
| 5 | Student experience | Phase 3, 4 |
| 6 | Onboarding & polish | Phase 4, 5 |
| 7 | Deployment & launch | Phase 6 |
| 8 | Level 2 payments & beyond | Phase 7 |

---

## Notes

- **Test-first throughout.** Every phase includes tests for its deliverables. No phase is "done" until tests pass.
- **Claude Code is the co-developer.** The CLAUDE.md file gives it full context. Point it at this plan and the relevant phase when starting work.
- **Mobile-first from Phase 4 onward.** Every UI component is designed for phone-in-hand use first.
- **Phases are sequential but tasks within a phase can be parallel.** E.g., in Phase 2, pricing engine and waitlist service are independent.
- **Student screens (Phase 5) are less defined than teacher screens.** Expect to design as you build — the student journey docx provides the user stories, but screen inventory needs to happen.
