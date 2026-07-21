# Overdue payment status in the students list

**Date:** 2026-07-21
**Status:** Approved

## Problem

A teacher scanning their students list cannot see who owes them money.
Overdue payments are only visible by opening each student's detail page
(or the payments settings page). The list should surface, per student,
how many of their payments are overdue.

## Decisions (made with Ivo)

- **Placement:** right side of each row — danger-colored caption stacked
  *below* the class count. Copy: `1 overdue`, `2 overdue`, … Hidden when
  the count is 0.
- **Sorting:** unchanged (alphabetical by first name). No reshuffling
  when payments settle.
- **Semantics:** counts `Payment.status = 'overdue'` only — pending and
  paid don't show. Overdue is already derived by the daily dunning sweep
  (`payment-reminders`), so the list self-heals as payments age or are
  marked paid.
- **Scope:** teacher-scoped. Only payments on registrations for classes
  owned by the requesting teacher count — same scoping the existing
  class count uses.

## Design

### API — `GET /api/students`

Each student row gains `overduePayments: number`.

Computed with one extra query per page (page size 20): a
`prisma.registration.groupBy` by `studentId`, filtered to the page's
student ids, `class: { teacherId }`, and `payment: { status: 'overdue' }`,
merged into the response mapping. No schema change, no service change —
the route already shapes the list inline (existing pattern).

The archived list uses the same route and component, so it inherits the
field for free.

### UI — `StudentDirectory` row

The right-side block becomes a column: class count on top; when
`overduePayments > 0`, a caption below in danger red
(`type-caption text-danger`): `{n} overdue`. The `unlinked` tag keeps
its current position beside the column. Text only — no badge, per the
design brief (danger is outline/text only).

### Seed

Two additional **completed** past classes (distinct dates, satisfying
`@@unique(templateId, date)`), small rosters mixing paid and overdue
payments, so the list shows a gradient out of the box:

| Student | Overdue after seeding |
|---|---|
| Iris | 3 (existing one + one per new class) |
| Hugo | 2 (one per new class) |
| Greta | 1 (first new class) |
| everyone else | 0 |

Registration prices reuse the existing tier price maps. These are
dev-visual fixtures, not pricing-engine test data; per-class totals are
plausible, not recomputed.

## Testing

Test-first at the integration level (`tests/integration/students-api.test.ts`):

1. Student with two overdue payments under the fixture teacher →
   `overduePayments: 2`.
2. An overdue payment on another teacher's class → not counted.
3. Pending/paid payments → `overduePayments: 0`, and no regression to
   existing fields (classCount, unlinked).

After implementation: re-seed and verify Iris 3 / Hugo 2 / Greta 1 in
the running app.

## Out of scope

- Sorting or filtering by overdue state.
- Showing pending counts or amounts owed in the list.
- Any change to the student detail page (it already lists payments).
- Notification/reminder behavior (dunning sweep unchanged).
