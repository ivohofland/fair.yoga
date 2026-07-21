# Booking Tier Respects Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Returning students see their tier + a settings link in the booking flow instead of the full picker (issue #19).

**Architecture:** The booking page computes `isFirstBooking` (zero registrations) and passes it down; `BookingFlow` branches its tier section on it. No API or schema changes.

**Spec:** `docs/superpowers/specs/2026-07-21-booking-tier-respects-settings-design.md`

## Global Constraints

- Returning copy exactly: `You're in Tier {n} · {label}.` / tiers 1–2: `You're in Tier {n} · {label} — does this still reflect your situation?`; link text `Change your tier in settings` → `/account`.
- Picker path byte-identical for first bookings; Book button and estimate footnote unchanged in both branches.
- Branch: `feat/booking-tier-respects-settings` off main (created).

---

### Task 1: Page computes `isFirstBooking`

**Files:** Modify `src/app/(public)/[slug]/book/[classId]/page.tsx` — student query gains `_count: { select: { registrations: true } }`; `<BookingFlow …>` gains `isFirstBooking={student._count.registrations === 0}`.

### Task 2: BookingFlow branches

**Files:** Modify `src/components/booking/booking-flow.tsx` — add `isFirstBooking: boolean` to props; wrap the radiogroup + intro copy in `isFirstBooking ? <picker> : <summary>`:

```tsx
        <div className="mb-1">
          <p className="type-body max-w-[420px]">
            You&apos;re in Tier {tierInfo.tier} · {tierInfo.label}
            {tier <= 2 ? ' — does this still reflect your situation?' : '.'}
          </p>
          <Link href="/account" className="inline-block mt-2 type-label text-teal no-underline">
            Change your tier in settings
          </Link>
        </div>
```

with `const tierInfo = TIER_INFO[tier - 1]!;`. Heading, footnote, Book button shared by both branches.

### Task 3: E2e + drive + PR

- `tests/e2e/booking.spec.ts`: second class fixture (same teacher/room, later date) + new test: returning student opens it → `Change your tier in settings` visible, `getByRole('radio')` count 0, `Book — around €…` works, registration created with `tierAtBooking` = profile tier. Run booking.spec + account-hybrid.spec locally.
- Drive: Jan (returning, tier 5 → plain sentence), Anna (tier 1 → confirmation question), screenshot.
- Full gates; commit per task; push; `gh pr create` (Closes #19).
