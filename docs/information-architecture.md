# Information Architecture — Teacher App

## How teachers think

A yoga teacher's mental model is built around their **schedule**. Their week is a series of classes. Everything else — students, rooms, payments, communication — is context around those classes. They don't think in database tables ("let me check my CRM"), they think in time ("what's happening this week?") and relationships ("how's my Tuesday group doing?").

The information architecture follows this natural mental model. The class is the central object. Everything connects through it.

---

## The class as central object

A class moves through a lifecycle, and the teacher's relationship with it changes at each stage:

```
[Future]  →  [Registering]  →  [Today]  →  [Completed]  →  [Archived]
 ↑ edit        ↑ monitor       ↑ teach      ↑ get paid       ↑ review
```

- **Future:** Created but no registrations yet. Fully editable. Teacher is sharing links, inviting students.
- **Registering:** Students are signing up. Economic settings locked. Teacher monitors registration count and tier distribution.
- **Today:** Class is happening. Teacher marks attendance, adds walk-ins. Mobile-optimized.
- **Completed:** Class is done. System calculated prices. Teacher tracks payments (Level 1) or payments are automated (Level 2).
- **Archived:** In the past. Part of history, reporting, and student attendance records.

The class detail screen adapts to show the right information and actions for each stage — not five separate screens, but one screen that transforms.

---

## Primary navigation

Four tabs. Not five — the original screen inventory had Dashboard and Classes as separate items, but they're really the same thing from the teacher's perspective. The teacher's "home" *is* their class schedule.

The bar is 64px with Lucide-style line icons (calendar, users, inbox, settings); the active tab shows a teal icon + label in a teal-tint pill, and the Inbox tab carries a small gold dot when unread. The bar renders only on the four tab roots — detail pages keep their back links instead. Class cards on the Schedule tab use the sand-soft surface with the registration progress bar and a status badge.

```
┌──────────────────────────────────────────────┐
│                                              │
│              [App Content]                   │
│                                              │
├──────────┬──────────┬──────────┬─────────────┤
│ Schedule │ Students │  Inbox   │  Settings   │
└──────────┴──────────┴──────────┴─────────────┘
```

### Tab 1: Schedule (home)
The teacher's world. This is the default tab, the landing page, the thing they see first.

### Tab 2: Students
Their community. The people who come to their classes.

### Tab 3: Inbox
Everything the system has told them. Persistent record of all notifications.

### Tab 4: Settings
Profile, rooms, payments, preferences. Things you set up once and rarely change.

---

## Tab 1: Schedule

This is the largest and most important section. It shows the teacher's classes across time.

```
Schedule
├── Week view (default)
│   ├── Class card → Class detail
│   ├── + Create class (FAB or button)
│   └── + Log studio class (quick entry)
│
├── Class detail (adapts to lifecycle stage)
│   ├── [Future] Full info + edit + share + cancel
│   ├── [Registering] Registration list + tier distribution + share
│   ├── [Today] Attendance view + add walk-in
│   ├── [Completed] Pricing summary + payment checklist
│   └── [Archived] Historical view + payment status
│
├── Create class (stepped flow)
│   ├── Step 1: Basics (room, date, time, type)
│   ├── Step 2: Pricing (rate range, student range, preview)
│   ├── Step 3: Policies (cancellation, auto-cancel)
│   └── Confirmation
│
├── Log studio class (quick entry — modal or half-sheet)
│   └── Date, time, location, students, hourly rate
│
└── Payment overview (cross-class)
    └── All outstanding payments, filterable
```

### Week view

The default view is a chronological list of the current week plus the next four weeks — matching how far recurring templates generate ahead (past weeks live under “View past classes”). Not a calendar grid — a simple list, ordered by time, with enough context on each card to know the status at a glance.

Each class card shows:
- Day, time, duration
- Class type and room name
- Registration progress: visual bar or fraction (e.g., "8 / 6–14")
- Status badge: registering, full, today, completed, cancelled
- Studio classes appear in the same timeline but visually distinct (no registration bar, just the class entry)

The teacher can scroll backwards to see completed classes (and their payment status) or forward to see upcoming ones. No separate "history" section — it's all one timeline.

### Class detail

This is the most important screen in the app. It's not one static design — it adapts based on where the class is in its lifecycle.

**Header (always visible):** class type, date, time, room, registration count.

**Body (changes by stage):**

| Stage | Primary content | Primary actions |
|-------|----------------|-----------------|
| Future | Settings summary, pricing preview | Edit, Share, Cancel |
| Registering | Student list, tier distribution, estimated prices | Share, Send announcement |
| Today | Attendance checklist, walk-in button | Mark present/absent, Add walk-in |
| Completed | Pricing breakdown, payment checklist | Mark paid, Send reminder |
| Archived | Final summary, payment status | View only |

The transition from "registering" to "today" to "completed" happens automatically based on time. The teacher never navigates to a different screen — the class detail evolves.

### Create class

A stepped flow (not a long form) that guides the teacher through setup. Each step fits on one mobile screen.

The pricing step is the most important — it includes the live preview table showing what students would pay at different class sizes. On mobile, this could be an expandable section below the inputs. On desktop, a side panel.

### Payment overview

Accessible from the Schedule tab (e.g., a "Payments" button in the header or a summary card). Cross-class view of all outstanding and received payments. Filterable by date range, class, or student. This is where the teacher goes to answer "who still owes me money?"

---

## Tab 2: Students

The teacher's community across all their classes.

```
Students
├── Student list (searchable, sortable)
│   ├── Student detail
│   │   ├── Attendance history
│   │   ├── Payment history
│   │   └── Shared info (based on student privacy settings)
│   │
│   ├── + Add student (CRM import, optional invite)
│   └── Send announcement (to selection or all)
│
└── Reporting
    ├── Total students reached
    ├── Income overview (independent + studio)
    └── Classes taught
```

### Student list

A simple searchable list. Not a "CRM dashboard" — it should feel like a personal address book. Each row shows the student's name, how many classes they've attended, and when they last came.

Teachers can add students manually (with optional platform invitation) for migrating existing students.

### Student detail

Tapping a student shows their relationship with this teacher: every class attended, cancellations, no-shows, payment history. Plus whatever optional info the student has chosen to share (email, phone, birthday, address).

### Reporting

A simple summary — not analytics. Total classes taught (independent + studio), total students reached, income breakdown. Numbers that help a teacher understand their practice over time. Accessible from the student list since it's about the teacher's overall picture.

### Send announcement

Can be triggered from the student list (to selected students or all) or from a class detail (to students in that class). Writes a message, shows a preview, sends. Simple.

---

## Tab 3: Inbox

```
Inbox
└── Notification list (chronological, read/unread)
    └── Tap → navigate to relevant screen
```

A simple chronological list. Each notification links to the relevant context (e.g., "Sarah registered for Tuesday Vinyasa" → tapping goes to that class detail). Read/unread states, nothing more.

The inbox is also where payment confirmations (Level 2) and system announcements live. It's the teacher's activity log.

---

## Tab 4: Settings

Things you configure once and occasionally update.

```
Settings
├── Profile
│   ├── Name, photo, bio (250 chars)
│   ├── Personal page URL
│   └── Custom domain
│
├── Rooms
│   ├── My rooms list
│   ├── Add new room (creation flow with duplicate detection)
│   ├── Search public library
│   └── Edit room overrides
│
├── Payments
│   ├── Bank details (Level 1: IBAN, account name)
│   ├── Payment processor (Level 2: connect Mollie/Stripe)
│   └── Payment level toggle
│
├── Notifications
│   └── Per-event email on/off toggles
│
└── Personal page preview
    └── See what students see
```

### Rooms in Settings

Rooms live under Settings because they're infrastructure — you set them up and then use them when creating classes. The class creation flow has a "select room" dropdown that pulls from these. If the teacher doesn't have a room yet, the dropdown offers "Add a room" which jumps to the room creation flow.

This means rooms are not a primary navigation item. Teachers don't browse their rooms daily — they set them up once, maybe add one when they find a new venue, and otherwise just pick from the list when making a class.

---

## Onboarding flow

The onboarding flow is not a separate section — it's a temporary overlay on the existing navigation that guides new teachers through first-time setup.

```
Onboarding (temporary, disappears when complete)
├── Step 1: Profile → Settings > Profile
├── Step 2: Room → Settings > Rooms > Add room
├── Step 3: Class → Schedule > Create class
└── Step 4: Share → Class detail > Share
```

Each step takes the teacher to the real screen where they'll do this task in the future. The onboarding just provides a "next step" prompt after each completion. This way the teacher learns the actual app, not a tutorial version of it.

---

## Flows

### Flow 1: Creating a first class (new teacher)

```
Sign up (magic link)
  → Profile setup (onboarding step 1)
    → Add room (onboarding step 2)
      → Create class (onboarding step 3)
        → Share page (onboarding step 4)
          → Schedule tab (onboarding complete)
```

### Flow 2: Weekly routine (established teacher)

```
Open app → Schedule tab (see this week)
  → Tap upcoming class → Class detail (registering)
    → Check registration count and tier distribution
      → Share link if spots available
  → Tap today's class → Class detail (today)
    → Mark attendance, add walk-in
  → Tap yesterday's class → Class detail (completed)
    → Check pricing breakdown
      → Mark payments received
        → Send a reminder on any still-unpaid row (one tap, per payment)
```

### Flow 3: Adding a walk-in

```
Class detail (today) → "Add walk-in" button
  → Search student → Select → Confirm
    → Back to class detail (student count updated, price recalculated)
```

### Flow 4: Checking payments

```
Settings tab → "Payments"
  → Payment overview (Outstanding / Received)
    → Tap "Send reminder" on an outstanding row (per-payment, inline)
```

### Flow 5: Sending an announcement

```
Option A: Class detail → "Send message" → Write → Preview → Send (to class students)
Option B: Students tab → Select students → "Send message" → Write → Preview → Send
```

---

## Modals and overlays

Not everything needs a full page. These actions work as modals, half-sheets, or inline expansions:

| Action | Surface |
|--------|---------|
| Log studio class | Half-sheet (quick entry) |
| Add walk-in | Half-sheet (search + confirm) |
| Share class link | Bottom sheet (URL + share buttons) |
| Send payment reminder | One tap, per payment (inline, not a modal) — the visible "Reminded …" stamp replaces a confirm |
| Cancel class | Confirmation dialog with explanation |
| Add student to CRM | Half-sheet or full page depending on bulk import |

---

## What changed from the screen inventory

The IA consolidates 36 screens into a leaner structure:

1. **Dashboard merged into Schedule.** The teacher's home is their schedule — no separate dashboard needed.
2. **Class detail is one adaptive screen,** not separate pre-class / class day / post-class screens. It transforms based on lifecycle stage.
3. **Rooms moved to Settings.** They're infrastructure, not daily-use. Reduces primary nav from 5 tabs to 4.
4. **Studio class entry is a quick modal,** not a separate screen. It appears in the schedule timeline alongside regular classes.
5. **Payment overview is part of Schedule,** not a standalone section. It's about "who owes me for which class."
6. **Reporting is part of Students,** not a standalone section. It's about understanding your community and income over time.
7. **Personal page preview is part of Settings,** accessible when editing profile or custom domain.

---

## Revised screen count

| Area | Screens | Notes |
|------|---------|-------|
| Auth & onboarding | 2 | Sign up, profile setup (onboarding is overlay) |
| Schedule tab | 4 | Week view, class detail (adaptive), create class (stepped), payment overview |
| Students tab | 3 | Student list, student detail, send announcement |
| Inbox tab | 1 | Notification list |
| Settings tab | 4 | Profile, rooms (list + create + edit), payments, notifications |
| Modals / overlays | 4 | Studio class entry, add walk-in, share sheet, cancel confirmation (reminders are inline, not a modal) |
| **Total** | **18** | Down from 36 by merging and adapting |

---

## Key design principle

**One object, one place.** A class lives on the Schedule tab. A student lives on the Students tab. Payments live on the class they belong to. There are no duplicate paths to the same information. The teacher always knows where to find something because everything has exactly one home.
