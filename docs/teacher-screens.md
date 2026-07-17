# Teacher Screens — Screen Inventory

Every screen the teacher interacts with, organized by journey phase. Each screen lists the tasks performed on it and navigation connections.

---

## Global Navigation

The teacher has a persistent bottom tab bar (64px, Lucide-style line icons) with exactly four items — Dashboard and Classes merged into Schedule, since the teacher's home *is* their schedule (see information-architecture.md).

**Primary navigation items:**
- Schedule (home — the week's classes)
- Students (CRM)
- Inbox (notifications & messages)
- Settings (index: recurring classes, studio classes, rooms, profile)

---

## Phase 1: Sign Up & Profile

### 1.1 — Sign Up
- Enter email address
- Receive magic link, click to verify
- *Leads to:* 1.2 Profile Setup (via onboarding flow)

### 1.2 — Profile Setup
- Enter name
- Upload profile picture (optional)
- Write short bio (max 250 characters, live character count)
- *Leads to:* 1.3 Onboarding — next step prompt

### 1.3 — Onboarding Progress
- Shows 4-step guided flow: ① Profile ② Room ③ Class ④ Share
- Each step shows completed/current/upcoming state
- Steps can be skipped and returned to later
- Disappears once all steps are complete
- *Leads to:* 2.1 Room Creation (step 2), 3.1 Class Creation (step 3), 4.1 Personal Page (step 4)

---

## Phase 2: Room Setup

### 2.1 — Room Creation: Address Entry
- Enter address (street, city, postcode)
- System immediately searches for existing rooms at that address
- Results appear inline below the address field
- If matches found: show existing rooms with "Use this room" option
- If no matches: proceed to create new room
- If clear duplicate: "Add to public library" checkbox is disabled
- *Leads to:* 2.2 Room Details (new room) or 2.3 Room Override (existing room)

### 2.2 — Room Details (New Room)
- Enter floor and room name/number
- Set absolute maximum capacity
- Select available equipment (mats, blocks, straps, bolsters, blankets — checkboxes)
- Add general notes about the space
- Toggle: public (visible to all teachers) or private
- *Leads to:* 2.3 Room Override

### 2.3 — Room Override (Per-Teacher Settings)
- Set personal maximum capacity (≤ room's absolute max)
- Set rental rate for this room
- Add notes about what equipment the teacher brings
- Save room to "My Rooms"
- *Leads to:* 2.4 My Rooms

### 2.4 — My Rooms List
- All rooms the teacher has configured
- Each entry shows: name, address, personal capacity, rental rate
- Actions: edit overrides, search public library, add new room
- *Leads to:* 2.3 Room Override (edit), 2.1 Room Creation (add new), 2.5 Room Library Search

### 2.5 — Room Library Search
- Search by city or address
- Results show public rooms with base properties
- Teacher can select a room and configure their own overrides
- *Leads to:* 2.3 Room Override

---

## Phase 3: Create a Class

### 3.1 — Class Creation: Basics
- Select room from "My Rooms" dropdown
- Set date and start time (or select "recurring weekly")
- Set duration
- Enter class type / description (e.g., vinyasa, yin, hatha)
- Room rental cost pre-filled from room config, editable
- *Leads to:* 3.2 Pricing Setup

### 3.2 — Pricing Setup
- Set minimum rate (accepts negative values)
- Set target rate
- Set minimum students (auto-cancel threshold)
- Set maximum students (waitlist threshold)
- Inline help text explaining scaling rate concept
- *Leads to:* 3.3 Pricing Preview (updates live alongside, or as next step)

### 3.3 — Pricing Preview
- Live-updating table showing:
  - Rows: different class sizes from min to max students
  - Columns: price per tier (1–5), teacher rate, total needed
- Updates in real time as teacher changes settings on 3.2
- Assumes balanced tier distribution
- Teacher can go back and adjust until happy
- *Could be:* side panel on desktop, expandable section on mobile, or integrated into 3.2
- *Leads to:* 3.4 Policy Settings

### 3.4 — Policy Settings
- Student cancellation deadline dropdown (48h, 24h, 12h, 6h — default 24h)
- Auto-cancel check dropdown (4h, 2h, 1h — default 2h)
- Validation: auto-cancel must be shorter than cancellation deadline
- *Leads to:* 3.5 Class Confirmation

### 3.5 — Class Confirmation
- Summary of all settings: room, date/time, pricing, policies
- For recurring: confirm weekly schedule, note that instances generate 4 weeks rolling
- Confirm / Create button
- After creation: class appears on personal page
- *Leads to:* 4.1 Personal Page or 5.1 Dashboard

### 3.6 — Class Edit
- Same fields as 3.1–3.4 but in edit mode
- Before any registrations: all fields editable
- After first registration: economic settings locked (greyed out with explanation)
- Non-economic fields (description, time, notes) remain editable
- For recurring: option to edit just this instance or the template for future instances
- *Leads to:* 5.2 Class Detail

---

## Phase 4: Share & Invite

### 4.1 — Personal Page (Public — Teacher's View)
- Preview of what students see: name, photo, bio, upcoming classes
- Each class shows: date, time, location, available spots (or "waitlist")
- Copy page URL button (app.com/teachername)
- Share buttons for social media
- *Leads to:* 4.2 Custom Domain Settings, 4.3 Class Share

### 4.2 — Custom Domain Settings
- Enter custom domain (e.g., yoga.janedoe.nl)
- DNS instructions displayed
- Status indicator: connected / pending / not configured
- *Accessible from:* Settings

### 4.3 — Class Share
- Specific class URL to copy
- Share buttons (WhatsApp, Instagram, email, etc.)
- *Accessible from:* 4.1 Personal Page, 5.2 Class Detail

### 4.4 — CRM Import / Add Student
- Enter student name and email
- Optional: send platform invitation (checkbox or button)
- Bulk import option (CSV or manual entry of multiple students)
- *Leads to:* 8.1 Student List

---

## Phase 5: Registration & Auto-Cancel

### 5.1 — Dashboard (Home)
- Overview of upcoming classes
- Each class card shows:
  - Date, time, room
  - Registration count vs. min and max (e.g., "8 / 6–14")
  - Visual indicator: below min (warning), above min (good), at max (full)
  - Aggregate tier distribution
- Quick actions: view class detail, create new class
- Recent notifications summary
- *Leads to:* 5.2 Class Detail, 3.1 Class Creation

### 5.2 — Class Detail (Pre-Class)
- Full class information: room, date/time, pricing settings, policies
- Registration list: student names (first + last initial), count
- Tier distribution (aggregate)
- Registration status: open / waitlist active / cancelled
- Current price estimate per tier based on actual registrations
- Actions: edit class (3.6), share class (4.3), cancel class
- Waitlist section: number of waitlisted students
- *Leads to:* 3.6 Class Edit, 4.3 Class Share, 6.1 Class Day View

---

## Phase 6: Class Day

### 6.1 — Class Day View
- Optimized for mobile (teacher at venue)
- List of registered students (first name + last initial)
- Checkbox per student: present / no-show
- Total students present and resulting price estimate
- "Add Walk-In" button
- *Leads to:* 6.2 Add Walk-In, 7.1 Post-Class Summary

### 6.2 — Add Walk-In
- Search for existing student by name or email
- Student must have an account with tier set
- Add to class — count updates, price estimate recalculates
- Note: walk-in can exceed max capacity
- *Leads back to:* 6.1 Class Day View

---

## Phase 7: Post-Class Billing

### 7.1 — Post-Class Summary
- Pricing breakdown:
  - Room cost
  - Effective teacher rate (and where it falls in min–target range)
  - Total needed
  - Number of students per tier
  - Price per tier
  - Teacher earnings
- *Leads to:* 7.2 Payment Checklist (Level 1) or auto-sends payment requests (Level 2)

### 7.2 — Payment Checklist (Level 1)
- List of students with amount owed per student
- Paid / unpaid toggle per student (manual marking)
- "Send Payment Reminder" button (sends to all unpaid students)
- Total received vs. total outstanding
- *Leads to:* 7.3 Payment Overview

### 7.3 — Payment Overview
- Cross-class view of all outstanding payments
- Filter by class, date range, or student
- Total outstanding, total received, total earned
- Per-student outstanding balance
- *Accessible from:* Dashboard, Settings

### 7.4 — Payment Processor Settings (Level 2)
- Connect Mollie or Stripe account
- Account status: connected / not connected
- Fee transparency: show processor fee rates
- Toggle between Level 1 and Level 2
- *Accessible from:* Settings

---

## Phase 8: Ongoing Teaching

### 8.1 — Student List (CRM)
- All students who have ever registered with the teacher
- Columns: name, classes attended, last attendance, frequency
- Search and filter
- Includes students from studio classes (if tracked)
- "Add Student" button (→ 4.4 CRM Import)
- *Leads to:* 8.2 Student Detail

### 8.2 — Student Detail
- Student name (first + last initial)
- Visible info based on student's privacy settings (email, phone, birthday, address — if shared)
- Attendance history: list of classes attended, no-shows, cancellations
- Total classes, first visit, last visit
- Payment history with this teacher
- *Leads back to:* 8.1 Student List

### 8.3 — Send Announcement
- Select audience: all students, students in a specific class, or custom selection
- Write message
- Preview
- Send (respects student communication preferences — skips opted-out students)
- Shows count of recipients
- *Accessible from:* 5.2 Class Detail, 8.1 Student List

### 8.4 — Studio Class Entry
- Date, time, location (text field — not linked to room library)
- Total number of students (entered after class)
- Hourly rate
- Quick entry — minimal fields, designed for fast logging
- *Accessible from:* Dashboard, Classes view

### 8.5 — Reporting / Income Overview
- Total classes taught (independent + studio) per period
- Total students reached per period
- Income breakdown: independent class earnings, studio hourly earnings
- Trends over time (weekly, monthly)
- *Accessible from:* Dashboard, Settings

---

## Settings

### 9.1 — Profile Settings
- Edit name, photo, bio (max 250 chars)
- Personal page URL display
- Custom domain configuration (→ 4.2)

### 9.2 — Bank Details (Level 1)
- IBAN and account holder name
- These are shown to students on the payment screen
- EPC QR code auto-generated from bank details

### 9.3 — Payment Processor (Level 2)
- Same as 7.4 — connect/disconnect Mollie or Stripe
- Fee overview

### 9.4 — Notification Preferences
- Which events trigger notifications for the teacher
- Email on/off per event type

---

## Inbox

### 10.1 — Teacher Inbox
- Chronological list of all system notifications
- Read/unread states
- Types: registration alerts, auto-cancel notices, payment received, system announcements
- Tap to expand detail or navigate to relevant screen

---

## Screen Count Summary

| Area | Screens |
|------|---------|
| Sign Up & Profile | 3 |
| Room Setup | 5 |
| Create a Class | 6 |
| Share & Invite | 4 |
| Registration & Dashboard | 2 |
| Class Day | 2 |
| Post-Class Billing | 4 |
| Ongoing Teaching | 5 |
| Settings | 4 |
| Inbox | 1 |
| **Total** | **36** |
