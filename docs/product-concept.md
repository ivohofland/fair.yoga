# Ethical Yoga App — Product Concept

## Vision

The most ethical yoga app. A platform that gives yoga teachers the tools to teach independently — scheduling, payments, simple CRM, and communication — while treating student privacy and financial accessibility as core design principles, not afterthoughts.

---

## Core Principles

**Teacher independence.** The teacher is the center of the platform. They bring their own students, manage their own classes, and control their own business. This is not a marketplace — it's a toolkit.

**Privacy first.** Students are identified only by first name + first letter of last name. Students control what additional information (if any) is visible to their teacher. The platform collects only what's necessary and puts data ownership in the student's hands.

**Financial accessibility.** Class pricing is based on what students can afford, using a transparent income-based model rooted in yogic ethics. The system distributes cost fairly so that yoga remains accessible regardless of income.

---

## Users

### Teachers
Yoga teachers who want to teach independently without relying on studios or large platforms. They need simple tools to manage their teaching practice: scheduling classes, tracking attendance, communicating with students, and getting paid fairly. No verification or certification required — the platform is open to anyone who wants to teach. Profile is minimal: name, profile picture, and a short bio (max 250 characters — about two sentences). This is an addition to their existing online presence, not a replacement.

**Onboarding:** A light guided flow walks new teachers through four steps: create profile, add first room, create first class, share your page. The flow disappears once complete — not a tutorial, just a natural path to getting started.

### Students
People who attend yoga classes. They create one account (during their first booking), register for classes, and are charged a fair price based on their self-reported income tier. They control their own privacy settings. One account works across all teachers on the platform.

### Teacher's Personal Page
Each teacher has a personal page (e.g., app.com/teachername) showing their profile and class schedule. This is the primary entry point for students. Students book directly from this page. (Connecting a custom domain on top of this page is a [non-goal](non-goals.md).)

---

## Feature Areas

### 1. Income-Based Pricing Engine

This is the heart of the app. The pricing model uses a compressed income-based spread with a scaling teacher rate.

**Inputs (teacher sets during class creation):**
- Room rental cost (per class)
- Minimum rate (what the teacher accepts at minimum class size)
- Target rate (what the teacher wants to earn at full class size)
- Minimum and maximum number of students
- Student income tiers (self-reported, see below)

**The algorithm:**

Step 1 — Calculate the effective teacher rate based on registrations:

`teacher rate = min rate + (target rate − min rate) × (students − min students) / (max students − min students)`

The rate is a per-class total (not per-student) that scales linearly: at minimum students the teacher earns their min rate, at maximum students they earn their target rate. The rate is capped at the target rate for classes exceeding maximum. As a class fills up, the same total cost gets divided among more people — students pay less while the teacher earns more.

Step 2 — Calculate each student's price:

`total class cost = room cost + teacher rate`
`student price = total class cost / sum of all student ratios × student's ratio`

**Tier ratios (compressed 2× spread):**

| Tier | Description | Ratio |
|------|------------|-------|
| 1 | Lowest income | 0.65× |
| 2 | Below average | 0.80× |
| 3 | Average | 1.00× |
| 4 | Above average | 1.20× |
| 5 | Highest income | 1.35× |

The ratios use a compressed spread: the inner step (tier 2↔3, tier 3↔4) is 0.20, while the outer step (tier 1↔2, tier 4↔5) is 0.15. This means choosing tier 2 or 4 makes the biggest difference, while tier 1 and 5 are a further nudge for people who truly need help or can genuinely afford more. The maximum ratio between tier 5 and tier 1 is 2.08× — the highest earner never pays more than about double the lowest.

**No price cap, no minimum price.** The teacher controls affordability through their settings: room choice, min/max students, and rate range. The pricing preview during class setup shows exactly what each tier would pay at different class sizes, so the teacher can adjust until they're comfortable.

**Scaling rate philosophy:** The scaling rate solves the momentum problem for new classes. A teacher building a new class can set a low minimum rate (or even a negative one, effectively subsidizing room costs as an investment) while still earning a fair target rate when the class fills up. Both sides win as the class grows: students pay less per person, and the teacher earns more.

Setting min rate and target rate to the same value collapses the scaling to a flat rate, making the feature fully backwards compatible without a toggle.

**Post-class billing:** Prices are calculated automatically at the end of class based on the final registration list. This list includes all registered students (late cancellations and no-shows are still charged), plus any walk-ins the teacher added during class. No user action is needed — the system runs the calculation when the class ends. Students see an estimated price range before class (based on the teacher's settings and current tier ratios) but the final amount is determined afterward.

**Walk-ins:** Teachers can add walk-in students during or just before class. The walk-in must have an existing account with a tier. Walk-ins can exceed the maximum student count — the actual number of students becomes the new count for the price calculation. The teacher rate remains capped at the target rate, so walk-ins beyond max simply lower everyone's price. Walk-ins benefit everyone — more people sharing costs means lower prices for all.

**Economic settings lock:** Once the first student registers for a class, the economic settings (room cost, min rate, target rate, min/max students) are locked. The teacher can still edit non-economic details (description, time, notes). If they need to change economics, they cancel the class and create a new one. For recurring classes, the template can be updated for future instances without affecting the current one.

**Income tier selection:**
- 5 tiers with compressed spread (0.65, 0.80, 1.00, 1.20, 1.35)
- Self-reported — no verification
- Framed through yogic philosophy rather than cold financial language
- Quotes from yoga texts (e.g., on Satya/truthfulness, Asteya/non-stealing) are shown during the income selection process to encourage honest self-reporting
- Tiers described in accessible, non-judgmental language rather than salary brackets

**Tier visibility:** Teachers can see the aggregate tier distribution of their class (e.g., "3 students in tier 1, 5 in tier 3, 2 in tier 5") but not which individual student is in which tier. This builds trust without breaking student privacy. Students do not see the tier distribution — only the total number of students, room cost, teacher earnings, and their own tier adjustment framed in plain language (e.g., "your tier contributes a bit more to keep prices fair for everyone").

**Tier is global:** A student's income tier is set once and applies across all teachers. Income doesn't change depending on who teaches the class.

**Tier changes:** Students can change their tier at any time — there is no cooldown. However, students in tier 1 or 2 see a gentle confirmation at each booking ("You're in tier 2 — does this still reflect your situation?") to nudge honest self-reporting. Tier 3, 4, and 5 students are not prompted. This is a natural place for a Satya quote.

**Open questions:**
- Exact tier labels and descriptions (deferred to UX copy phase)
- Yogic quotes for tier selection — content and rotation (deferred to UX copy phase)

### 2. Class Scheduling & Registration

**For teachers:**
- Create classes with date, time, duration, location, and description
- Set minimum and maximum number of students
- Set up recurring classes (weekly) that generate individual instances
- Minimum student threshold is teacher-configurable — determines when a class auto-cancels
- The teacher decides how much financial risk they're willing to take by setting these thresholds

**For students:**
- Browse available classes from their teacher(s) via the teacher's personal page
- Register for classes (registration stays open until class starts)
- Account creation happens as part of the first booking flow
- One account works across all teachers on the platform
- See estimated price range based on their tier and the class size range

**Teacher settings (per class):**
- Student cancellation deadline: 48h, 24h, 12h, or 6h (default: 24h)
- Auto-cancel check: 4h, 2h, or 1h before class (default: 2h)
- Auto-cancel time must be shorter than the cancellation deadline

**Recurring classes:** Run indefinitely until the teacher stops them — no end date needed. Instances are auto-generated on a rolling 4-week basis.

**Waitlist:** When a class reaches maximum capacity, additional students join a waitlist. Waitlist promotion follows two rules depending on timing:

- **Before the cutoff** (1 hour before cancellation deadline): the first person on the waitlist is automatically promoted and notified. They have until the cancellation deadline to cancel if needed.
- **In the final hour before the deadline**: everyone remaining on the waitlist gets a notification that a spot opened. First to claim it gets in — they accept knowing they can't cancel anymore.
- **After the cancellation deadline**: the waitlist is frozen. No more movement. The registration list is final.

### 3. Cancellation Policy & No-Shows

Two separate deadlines serve different purposes:

**Student cancellation deadline** (48/24/12/6h before class): the cutoff for penalty-free cancellation. Students who cancel after this deadline or who don't show up are still included in the price calculation and charged their share.

**Auto-cancel check** (4/2/1h before class): the system checks if the minimum number of students is registered. If not, the class is automatically cancelled and all students are notified. No charges are applied. No teacher action is required.

**No-shows:** treated the same as late cancellations — included in the distribution and charged accordingly. No-shows receive a friendly "we missed you" notification.

**Early cancellations** (before the cancellation deadline): removed from the calculation, no charge.

**Grace policies:** No system-level grace policy for cancellations or emergencies. If a student has a genuine emergency, they talk to their teacher. The teacher can manually mark someone as "not charged" if they choose to be lenient. This keeps the relationship human and teacher-centric.

### 4. Room / Space Database

A shared library of teaching spaces, with teacher-specific overrides.

**Room base properties** (shared across all teachers who use the space):
- Name and address
- Type: public venue (community center, library) or private space
- Absolute maximum capacity
- Available equipment: mats, blocks, straps, bolsters, blankets, etc.
- General amenities and notes

**Teacher-specific overrides:**
Each teacher can customize room settings for their own practice:
- **Capacity override:** a room might hold 20 people, but a teacher may set their personal max at 12 for a more intimate class
- **Rental rate:** different teachers may negotiate different rates for the same space
- **Equipment notes:** what the teacher brings vs. what's at the venue

**Room types:**
- **Library rooms** — shared/public spaces that multiple teachers might use
- **Private rooms** — spaces only associated with one teacher (home studio, private rental, etc.)

**Room creation flow:** When a teacher starts creating a room and enters an address, the system immediately searches the existing library and shows matches. The teacher can adopt an existing public room (with their own overrides) or create a new one. If a clear duplicate exists, the "Add to public library" option is not available — they can only use the existing room or keep theirs private.

**Room base property management:** Once a room is public, its base properties (address, capacity, equipment, amenities) are read-only for *everyone* — including the room's original creator, who may have left the platform or stopped maintaining it. Teachers can suggest changes, which a platform admin reviews and applies. Teacher-specific overrides (capacity, rate, equipment notes) are always freely editable by each teacher. *(The suggestion channel and admin room management are **deferred** — they need an admin surface that doesn't exist yet, the same dependency as duplicate merging below. The read-only lock itself is enforced today.)*

**Room search:** The library is searchable by city or address. No map view needed for v1.

**Duplicate merging:** Admin-only tool for merging duplicate rooms. Deferred — not in v1.

### 5. Simple CRM

Lightweight teacher-facing tools for managing their student community.

**Attendance tracking:**
- Automatic tracking based on class registration and check-in
- Attendance history per student
- Class-level attendance overview

**Student information:**
- First name + first letter of last name (always visible)
- Additional info only visible based on student's privacy preferences
- Income tier: teacher sees aggregate distribution per class (e.g., "3 in tier 1, 5 in tier 3") but not individual student tiers

**Student fields:**
- Required: first name, last name, email
- Optional: phone, birthday, address
- No general notes field, no experience level, no health data (GDPR special category risk)
- Address is useful for personal touches (e.g., teacher sending a Christmas card) and future features (private bookings)

**CRM student import:** Teachers can add students to the CRM manually (e.g., migrating existing students). As an optional step in the process, they can send a platform invitation to the student.

### 6. Communication

Three-layer communication model, same content, different delivery:

**In-app notifications:** Real-time alerts for time-sensitive events (waitlist promotion, class cancellation, booking confirmation).

**In-app inbox:** Persistent chronological log of all notifications. Acts as a personal activity history — booking confirmations, payment requests, class updates. Always available regardless of email settings. Important for Level 1: the payment request with bank details or Tikkie link lives here permanently.

**Email:** External fallback. The system sends in-app first; if the student hasn't seen it within a reasonable window, email follows. Student controls whether email notifications are on or off (on by default).

**Class reminders:** On by default, set to morning-of. Student can change to: evening before, 1 hour before, or off. Global setting from account settings, applies to all bookings.

**Teacher capabilities:**
- Send one-to-many announcements to all students in a class
- Notify about schedule changes or cancellations
- Cannot contact students who have opted out
- No group chat — teachers use external tools (WhatsApp, Telegram) for community chat

### 7. Payments

The platform is not a financial intermediary. It never holds or moves money. Instead, it calculates prices and facilitates payment between student and teacher. Two levels of payment support are available:

**Level 1: Direct Payment (default)**

The system calculates each student's price after class and displays it. The student pays the teacher directly using whichever method works for them. The platform provides multiple convenience options but does not process the payment:

- Teacher's bank details displayed (IBAN, name, payment reference)
- "Copy payment details" button for mobile users
- EPC QR code for scanning with a banking app (useful when viewing on a different device than the one used for payment)
- Tikkie, cash, or any other method the teacher accepts

The teacher manually tracks payments in the system — a simple per-class checklist showing each student, the amount owed, and paid/unpaid status. Zero fees, no payment processor needed.

**Level 2: Integrated Payment (teacher connects Mollie or Stripe)**

Teachers who want automated payment processing can connect their own Mollie or Stripe account. The platform sends payment requests through the teacher's account. Money goes directly from student to teacher — the platform never touches it.

- iDEAL, credit card, and other payment methods supported by the processor
- Automatic charging after class
- Automatic payment tracking (no manual marking needed)
- Teacher pays processor fees from their own account
- Net payout (after fees) is clearly shown to the teacher

The teacher owns the payment account and the relationship with the processor. The platform is an integration layer, not a payment service.

**Open payments:** Students with unpaid classes are not blocked from booking. Instead, they see a friendly reminder during the booking flow ("You have 2 open payments"). No blocking in v1 — visibility is enough.

**Payment reminders:** Level 1 teachers can send a payment reminder manually at any time, one tap per outstanding payment. The system also sends a single gentle reminder once a payment goes overdue, repeated at most once a week — a quiet nudge, never a barrage. A manual send resets that weekly clock, so frequent manual reminders replace the automatic one rather than stacking on top of it.

**Open questions:**
- How to handle failed payments in Level 2? Retry policy? (parked — v1 Level 2 is payment links, not automated charging)

### 8. Studio Class Tracking

Teachers who also teach at studios can register those classes in the system. The income-based pricing engine does not apply to studio classes (the studio sets prices). This is purely a teacher feature for having a complete calendar and basic reporting.

**Studio class entry:** Date, time, location, total number of students (no individual registration), and hourly rate. The teacher adds the student count after class. No CRM integration for individual students in studio classes.

**Reporting:** Feeds into total classes taught, total students reached, and income tracking across all teaching environments (independent + studio). Having the hourly rate enables a complete income picture.

This also creates a natural pathway: a student who discovers a teacher through a studio class and sees they also teach independent classes with fair pricing may choose to attend those as well.

---

## Privacy Model

| Data | Visibility |
|------|-----------|
| First name + last initial | Always visible to teacher |
| Income tier (individual) | Never visible to teacher |
| Income tier (aggregate per class) | Visible to teacher (e.g., "3 in tier 1, 5 in tier 3") |
| Email | Per-teacher opt-in by student |
| Phone (optional) | Per-teacher opt-in by student |
| Birthday (optional) | Per-teacher opt-in by student |
| Address (optional) | Per-teacher opt-in by student |
| Attendance history | Visible to teacher |
| Payment details | Never visible to teacher |

The global default is maximum privacy — only first name and last initial. Students can override these defaults on a per-teacher basis, sharing additional information with teachers they trust. This allows the teacher-student relationship to deepen naturally over time.

---

## Ethical Positioning

The app's brand is built on yogic principles applied to the business of teaching yoga:

- **Satya (truthfulness)** — students self-report income honestly
- **Asteya (non-stealing)** — pricing ensures no one is priced out of practice
- **Aparigraha (non-possessiveness)** — minimal data collection, student-controlled privacy
- **Ahimsa (non-harm)** — the system is designed so that financial pressure doesn't fall disproportionately on anyone

This isn't just marketing — these principles are embedded in the product's mechanics.

---

## Revenue Model

The platform is free. No fees, no cuts, no subscriptions. The only thing the platform asks in return is that teachers use the income-based pricing system for their independent classes. This is a philosophy-first project, not a revenue-driven business.

**Sustainability model:**
- Open source codebase on GitHub — full transparency, community contributions welcome
- Volunteer development from the yoga-tech community
- Voluntary teacher donations to cover running costs (hosting, payment integration, etc.)
- Transparent running costs page showing real platform expenses and donation status — teachers see exactly where their donation goes, just like students see where their class payment goes
- Dana (generosity) framing — a gentle prompt after successful classes, never blocking, never nagging
- No premium features behind donations, no badges, no shame for non-donors

## No Gamification

The platform deliberately avoids attention economy mechanics. No monthly summary emails, no attendance streaks, no "you attended 12 classes this month!" badges, no "your loyalty lowered prices" messaging. These patterns shift motivation from practicing because it feels right to practicing because the app told you to. If a student wants to reflect on their practice, the inbox history is there — the app doesn't package it up and nudge them. This is consistent with the yogic values the app is built on.

## Affordability Through Community

Rather than introducing monthly caps or commitment discounts (which would shift costs to other students or reduce teacher income), affordability for frequent practitioners is achieved naturally through the per-class model: a teacher with a loyal, consistent student base fills classes reliably. More students per class means the same total cost is divided across more people, so everyone's price drops. Frequent students benefit not from a special mechanism, but from the system working as intended.

## Authentication

No passwords. Two authentication methods:
- **Magic link via email** — primary method. Student clicks a link, they're in. Works perfectly for class reminder emails where the link logs them in and takes them straight to booking.
- **Passkeys** — optional upgrade for convenience. Face ID, fingerprint, no typing. Ideal for mobile-first yoga booking flow.

No SMS-based magic links — per-message costs contradict the free platform model.

## International & Language

English first, international from day one. The Netherlands is the home base but not a constraint — the initial user base includes international teacher training groups (primarily UK and US). Payment localization (Mollie for NL, Stripe for US/UK) deferred to Level 2. Being open source enables community-driven localization.

## Open Strategic Questions

1. **Legal considerations:** GDPR compliance for income data, payment regulations, liability for self-reported income accuracy.
2. **Student data export:** Teachers should be able to export their student list (philosophically aligned with independence). Deferred — not v1.
3. **Referral tracking:** Can the teacher see how students found their page? Deferred — not v1.
