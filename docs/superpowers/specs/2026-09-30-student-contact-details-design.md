# Student contact details — design (#714)

A student can enter, change and clear their phone, birthday and address from
`/account`, and share each with a teacher per teacher. Birthday splits into two
independent disclosures: the **day and month** (for birthday wishes) and the
**age** (for a teacher estimating what a student can do). Neither ever carries
the birth year to a teacher.

Follow-up to #400, which added the name input and left these three out.

## What was measured

### The issue's premise

Held:

- No UI sends `phone`, `birthday` or `address`. The PUT's UI callers are
  `name-form.tsx`, `tier-form.tsx`, `notifications-form.tsx` and
  `booking-flow.tsx`; none sends these keys. No creation path sets them.
- `updateStudentSchema` types all three as `z.string().nullable().optional()`,
  and the route spreads the parsed body into `prisma.student.update`.
- Export already carries all three (`src/services/gdpr.ts`, the export's
  student block) and erasure already nulls them (the erasure's closing
  `student.update`). Nothing to do there.

The issue said a date-only birthday "probably" 500s and that nobody had run
it. Run on 2026-09-30 against the worktree's app, as the student themself,
`PUT /api/students/[id]` (throwaway probe, deleted afterwards):

| Body | Status | Stored |
|---|---|---|
| `birthday: "1990-01-01"` | **500** | unchanged |
| `birthday: "1990-01-01T00:00:00.000Z"` | 200 | `1990-01-01` |
| `birthday: "1990-01-01T23:30:00+02:00"` | 200 | `1990-01-01` |
| `birthday: "not-a-date"` | **500** | unchanged |
| `birthday: ""` | **500** | unchanged |
| `phone: ""`, `address: ""` | 200 | `""` (not null) |

`<input type="date">` sends exactly the first row's shape, so a form built on
today's schema would 500 on every save.

### What the issue got wrong, or did not see

1. **The day-shift risk is real but sits in the instant, not the date string.**
   Postgres truncates an instant to its **UTC** calendar date. A client sending
   local midnight east of UTC (`1990-01-01T00:00:00+02:00` is
   `1989-12-31T22:00Z`) would store 31 December. The fix is to accept only
   `YYYY-MM-DD` on the wire and build the `Date` on the server with `Date.UTC`.
2. **"Teachers see day and month only" held on the page and not at the API.**
   `students/[id]/page.tsx` renders with `formatDateShort` — a deliberate
   choice, argued in `2026-07-31-calendar-day-boundaries-design.md` ("a birth
   *year* is a different disclosure from a birth *date*") and kept in
   `2026-07-31-one-date-format-design.md`. But `projectStudentForTeacher`
   returns `birthday: Date`, year included, and eight call sites put it on
   teacher-facing responses — `GET /api/students/[id]` among them. (`grep -rn
   "projectStudentForTeacher(" src | grep -v '\.test\.'` gives 10 hits; minus
   the definition and one docblock mention in `services/payments.ts` = 8.) The rule lived in a formatter; the API sat in front of it.
   Moot today, because the column is always null. This issue makes it fillable,
   so the rule moves into the projection's type.

## Decisions

Taken at the brainstorming gate, 2026-09-30:

- **Two share toggles for birthday**: "Birthday (day and month)" on the
  existing `shareBirthday`, and a new "Age" on `shareAge`. Independent — either
  can be on without the other. Both default off.
  The ability-estimate use sits close to what *Key Constraints* excludes (no
  experience levels); what distinguishes it is that the student opts in, per
  teacher, to a field separate from the birthday itself.
- **The stored year never reaches a teacher**, on any path. Enforced by the
  projection's type, not a formatter. A student who shares both the birthday
  (day and month) and the age lets that teacher work out the year, so the two
  disclosures together are the student's choice to make, not a leak.
- **Separate forms** on `/account`: `NameForm` unchanged, a new
  `ContactDetailsForm` below it with its own save. The name is required and
  these are optional; one form would let a blank surname block saving a phone.
- **Address is a textarea.**
- **Empty-field hint** on the privacy card: "Not added yet — add it in
  Settings", linking to `/account`. The toggle stays enabled.

## Design

### Data

Migration: `StudentPrivacy.shareAge Boolean @default(false)`. No backfill —
the default is maximum privacy, and the app is not in production.

`birthday` stays `DateTime @db.Date`. The year is collected (the age needs it)
and withheld at the projection.

### Wire (`updateStudentSchema`, `src/lib/schemas.ts`)

- `birthday`: a string matching `YYYY-MM-DD` that is a real calendar date
  (`2023-02-30` refused), not after today (UTC), not before `1900-01-01`;
  transformed to `new Date(Date.UTC(y, m - 1, d))`. `""` and `null` → `null`.
- `phone`: trimmed, max 40 characters. `""` and `null` → `null`.
- `address`: trimmed, max 300 characters, newlines allowed. `""` and `null` →
  `null`.
- A malformed value is a **400** naming the field, through the existing
  `parseBody` path. The route itself needs no change: the transform delivers a
  `Date | null` that the existing spread writes.

`updatePrivacySchema` gains `shareAge: z.boolean().optional()`.

### Projection (`src/lib/student-visibility.ts`)

`TeacherVisibleStudent` changes:

```ts
birthday: { day: number; month: number } | null;  // gated on shareBirthday
age: number | null;                               // gated on shareAge
```

- `VisibilityFlags` adds `shareAge`. `_visibilityFlagsAreExhaustive` fails the
  build until it does — that failure is the pin working.
- `_projectionCarriesNoRawIdentity`'s allowlist adds `'age'`, which is what
  forces the "may a teacher see this?" question for the new key. Its docblock's
  "these seven keys" is a prose count this change falsifies; per *Comment
  Discipline*, drop the number rather than update it.
- `age` is whole years from the stored date to today's UTC calendar date.
  `projectStudentForTeacher` takes an optional `now: Date = new Date()` so the
  unit tests pin it without a fake clock. UTC rather than the teacher's zone:
  the call sites do not all have the teacher's timezone to hand, and the
  cost is an age that turns over up to a few hours early or late on the
  birthday itself.
- A 29 February birthday: `day: 29, month: 2`; the age turns over on
  1 March in non-leap years.
- `studentVisibilitySelect` selects `shareAge`.

Because `birthday` is no longer a `Date` on the teacher shape, the compiler
refuses any teacher surface that tries to format it with a year-bearing
formatter.

### Writers of the share flags

Every place that writes a full `StudentPrivacy` flag set must add
`shareAge: false` (or the student's value). Census on this branch, re-derived
by `grep -rn "shareBirthday" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'`:
`account/privacy/page.tsx` (defaults and row mapping),
`api/students/[id]/privacy/route.ts` (defaults), `services/invitations.ts`,
`services/student-privacy.ts`, `services/gdpr.ts` (export), the schema, the
card, and the projection. The plan re-runs the grep with `shareAge` and
reconciles every hit.

### Account form (`src/components/student/contact-details-form.tsx`)

- Phone: `type="tel"`, `autoComplete="tel"`.
- Birthday: `type="date"`, `max` = today, `min` = `1900-01-01`. Initial value
  from the stored date via UTC accessors (`toISOString().slice(0, 10)`).
  Hint: "Share it per teacher under Privacy — as your birthday (day and
  month), your age, or both."
- Address: `Textarea` (`src/components/ui/textarea.tsx`), `autoComplete="street-address"`.
- One "Save contact details" button. Clearing a field and saving is a normal
  save, storing null. `Saved` confirmation, error clear-on-change, and a
  server 400 shown against its field — all per
  `docs/form-validation-accessibility.md`.
- The `_formHasNoExtras` reverse pin against `updateStudentSchema`, as
  `name-form.tsx` has.
- `Input` gains an optional `hint` prop; `aria-describedby` joins the hint
  and error ids. Check `Textarea` for the same shape and match it.

`account/page.tsx` selects the three fields and renders the form under
`NameForm` in "Personal details".

### Privacy card (`src/components/student/teacher-privacy-card.tsx`)

- Labels: Full last name · Email address · Phone number · **Birthday (day and
  month)** · **Age** · Address.
- Under a toggle whose field is empty — phone, birthday (for both birthday and
  age), address — a caption: "Not added yet — add it in Settings", the last
  words linking to `/account`. The toggle stays enabled; sharing an empty
  field returns null.
- The page passes **presence booleans** (`hasPhone`, `hasBirthday`,
  `hasAddress`), never the values.

### Teacher page (`src/app/(teacher)/students/[id]/page.tsx`)

- Birthday renders `12 Jun` from `{ day, month }` — a small formatter in
  `src/lib/format.ts` sharing `formatDateShort`'s month table.
- Age as its own row, only when non-null.
- The "nothing shared" empty state counts `age` too.

### Docs

- `docs/data-model.md`: `share_age` row; `birthday`'s note says the year is
  never shown to a teacher.
- `docs/product-concept.md`: the visibility table's Birthday row becomes
  "Birthday (day and month)", and an Age row is added.

## Tests (written first)

- **Route integration** (`tests/integration/students-api.test.ts`, the
  existing PUT block): for each field — set, change, clear with `null`, clear
  with `""` → null. Birthday: `"1990-01-01"` round-trips as `1990-01-01`;
  a future date, `2023-02-30`, `"not-a-date"` and an offset instant are 400s
  and leave the row unchanged. Over-length phone/address → 400.
- **Projection unit** (`student-visibility.test.ts`): the four combinations of
  `shareBirthday` × `shareAge`; no key of the teacher shape carries the year
  (serialise and assert the four-digit year is absent); age across the
  birthday boundary and on 29 February, with `now` pinned.
- **Teacher GET integration**: a linked teacher's `GET /api/students/[id]`
  over a student sharing birthday returns `{ day, month }` and no year.
- **Components**: `ContactDetailsForm` (sends trimmed values, `""` sent as
  clear, 400 shown on its field, hint wired to `aria-describedby`); the
  privacy card's empty-field caption and the new Age toggle.
- **e2e**: a student fills in all three, shares only the phone with a
  teacher; the teacher's page shows the phone and nothing else.

## Guards to prove bite

Each is broken on purpose, the exact failure recorded, then restored:

- Remove the `Date.UTC` construction (pass the string through) → the route
  round-trip test goes red.
- Return `student.birthday` unprojected → the no-year unit test and the
  teacher GET test go red.
- Drop `shareAge` from `VisibilityFlags` → `tsc` fails on
  `_visibilityFlagsAreExhaustive`.
- Gate `age` on `shareBirthday` instead of `shareAge` → the four-combination
  unit test goes red.

## Not this issue

- Changing a student's email, or collecting these fields at signup (as the
  issue states).
- Validating phone numbers beyond length — international formats vary too
  much for a check that would help more than it refuses.
- Computing age in the teacher's timezone.
