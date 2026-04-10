# Ethical Yoga App

A free, open-source toolkit for independent yoga teachers. Not a marketplace — a utility. Teachers bring their own students, manage their own classes, control their own business.

## Tech Stack

- **Framework:** Next.js 14+ (App Router) — single process for frontend, SSR, and API
- **Language:** TypeScript with `strict: true` — no `any`, no implicit types, non-negotiable
- **Database:** PostgreSQL with Prisma ORM
- **Auth:** Magic link (oslo/crypto) + passkeys (@simplewebauthn/server). No passwords, no SMS. Sessions stored in DB.
- **Email:** Resend (transactional)
- **Styling:** Tailwind CSS
- **Testing:** Vitest (unit/integration) + Playwright (e2e)
- **Real-time:** Server-Sent Events for notifications
- **Deployment:** Single VPS, Docker (Next.js + PostgreSQL), Nginx, Let's Encrypt

→ Full details: `docs/technical-architecture.md`

## Development Principles

**Test-first development.** Every feature starts with a failing test. Write test → see it fail → implement → see it pass → refactor. No PR merges without tests covering the change. This applies at all levels: unit tests for business logic, integration tests for API routes, e2e tests for user flows.

**TypeScript strict mode.** The compiler is the first line of defense. For an open-source project with volunteer contributors, strictness prevents entire categories of bugs.

**Services are framework-agnostic.** Business logic in `src/services/` takes typed inputs and returns typed outputs. No HTTP concerns, no framework imports. API routes are thin wrappers. This makes services independently testable and extractable if a separate API is ever needed.

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

Classes move through states: `draft → open → full → in_progress → completed → cancelled`

- `settings_locked` flips true on first registration — economic fields become immutable
- Recurring classes: template generates instances on rolling 4-week basis, runs indefinitely
- Auto-cancel: system checks at configured time, cancels if below min_students
- Walk-ins can exceed max_students — teacher rate stays capped at target, extra students lower everyone's price
- After completion: pricing engine runs → payments created → notifications sent

### Waitlist (Hybrid Promotion)

- Before cancel deadline: auto-promote next in queue
- Final hour before class: switch to first-come-first-claimed broadcast
- Frozen after deadline — no more promotions

### Payment Model

- **Level 1 (default):** Platform calculates prices. Student pays teacher directly (bank transfer, cash, etc). Teacher marks paid manually.
- **Level 2:** Teacher connects Mollie (EU) or Stripe (US). Payment links sent to students. Teacher pays processor fees. Platform is never a financial intermediary.

### Communication (Three Layers)

1. In-app notification (real-time via SSE)
2. In-app inbox (persistent record)
3. Email fallback (for unread notifications, student can opt out)

One-to-many only. No group chat. Teachers use external tools for community.

### Announcements

Teacher sends message to all students of a specific class (or all their students). Creates one Notification per recipient.

## Data Model

11 entities across 6 domains: People (Teacher, Student, StudentPrivacy), Spaces (Room, TeacherRoom), Classes (ClassTemplate, Class, StudioClass), Bookings (Registration, WaitlistEntry), Payments (Payment), Communication (Notification, Announcement).

Key design decisions:
- `tier_at_booking` on Registration captures income tier at booking time — serves as income history, no separate tracking needed
- `StudentPrivacy` is per-teacher — students control what each teacher can see, default is maximum privacy
- `TeacherRoom` holds private rental rate per teacher — never shared between teachers
- `StudioClass` is disconnected from Room/Student — pure calendar + income tracking
- Auth tables managed by auth layer, not in domain model

→ Full schema with all fields and types: `docs/data-model.md`

## Information Architecture

**Accordion home base** — the teacher dashboard is a single page with four collapsible sections:

**Schedule** (home) · **Students** (CRM) · **Inbox** (notifications) · **Settings** (profile, rooms, payments)

- One section open at a time, others collapse. Text-only headers, no icons.
- **Detail views are separate pages** — tapping a class, student, or notification opens a full page. The accordion is the home base you return to.
- Class detail is one adaptive page that transforms based on lifecycle stage (draft → open → full → in_progress → completed → cancelled)
- Dashboard IS the schedule — no separate dashboard
- Rooms are in Settings (set-up-once infrastructure)
- Studio classes are a quick entry in the schedule list

→ Full IA reference: `docs/information-architecture.md`
→ Navigation and component patterns: `docs/design-brief.md`

## Project Structure

```
src/
├── app/
│   ├── (public)/          # SSR pages: teacher booking page, login, verify
│   ├── (teacher)/         # Auth required: schedule, students, inbox, settings, class/[id]
│   ├── (student)/         # Auth required: bookings, settings
│   └── api/               # Thin route handlers → delegate to services
├── services/              # Pure business logic (pricing, class-lifecycle, waitlist, notifications, payments)
├── lib/                   # Shared utilities (auth, db, email, types)
└── components/            # React components (ui, schedule, class, students, layout)
tests/
├── e2e/                   # Playwright
└── integration/           # API route tests
```

## Design Philosophy

E-reader meets dumb phone. The interface is a document you interact with, not an app you navigate.

- **Mobile-first** — teachers use this on their phone between and during classes
- **No animations, no transitions, no shadows, no depth** — screens just appear
- **Lists over cards** — simple rows with dividers, not card-based layouts
- **Text-only navigation** — no icons in nav, no tab bar. Accordion home base.
- **No gamification** — no streaks, no badges, no monthly summaries, no loyalty messaging
- **No attention economy patterns** — this is a tool, not an engagement platform
- **Cursor pointer on all interactive elements** — all `<a>` and `<button>` elements get `cursor: pointer` globally via CSS. No need to add `cursor-pointer` class individually.
- Typography: Georgia headings, Atkinson Hyperlegible body (fallback: Arial)
- Colors: deep teal (#1A5653), warm sand (#E8DCC8), soft white (#F7F4EF), earth brown (#6B5B4E), muted gold (#C4A96A)

→ Working design brief: `docs/design-brief.md`
→ Original visual reference: `docs/stitch-design-brief.md`

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
| `docs/stitch-design-brief.md` | Visual design brief — colors, typography, components, spacing |
| `docs/implementation-plan.md` | 8-phase implementation plan with task breakdowns |
| `docs/visual/teacher-journey.docx` | 8-phase teacher journey with user stories and acceptance criteria |
| `docs/visual/student-journey.docx` | 4-phase student journey with user stories and acceptance criteria |
| `docs/visual/pricing-simulator.html` | Interactive pricing simulator with editable tier ratios |
| `docs/visual/data-model.html` | Visual ERD with interactive domain filtering |
