# Students CRM — Design Spec

Teacher-facing student management: list with search and pagination, create new students, and the data model changes to support an "unattached" student state.

## Data Model Changes

### New field: `Student.claimedAt`

Nullable `DateTime` on the existing `Student` model. Null means the student was created by a teacher and hasn't signed up yet. Set once when the student creates their own account with that email. Global — not per-teacher.

```prisma
model Student {
  // ... existing fields
  claimedAt DateTime?
}
```

### New model: `TeacherStudent`

Join table representing "this teacher has this student in their contacts." Decouples the contact list from booking history — a teacher can have a student in their CRM without any class registrations.

```prisma
model TeacherStudent {
  id        String   @id @default(uuid())
  teacherId String
  studentId String
  createdAt DateTime @default(now())

  teacher Teacher @relation(fields: [teacherId], references: [id], onDelete: Cascade)
  student Student @relation(fields: [studentId], references: [id], onDelete: Cascade)

  @@unique([teacherId, studentId])
}
```

Add the corresponding relation arrays to `Teacher` and `Student`:
- `Teacher.teacherStudents: TeacherStudent[]`
- `Student.teacherStudents: TeacherStudent[]`

### Migration impact

- One new table (`TeacherStudent`)
- One new nullable column on `Student` (`claimedAt`)
- Existing data unaffected — all current students will have `claimedAt: null`
- Backfill: create `TeacherStudent` records for any existing teacher-student relationships (derived from registrations)

## API

### `GET /api/students` (new)

Returns the current teacher's students with search and pagination.

**Auth:** Teacher session required.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `search` | string | `""` | Case-insensitive contains match on firstName, lastName, or email |
| `page` | int | `1` | 1-indexed page number |
| `pageSize` | int | `20` | Results per page (max 50) |

**Query logic:**
1. Filter to students linked to the teacher via `TeacherStudent`
2. If `search` is non-empty, filter where firstName OR lastName OR email contains the search term (case-insensitive)
3. Order by firstName ascending
4. Apply pagination (skip/take)
5. Return total count for pagination controls

**Response:**
```json
{
  "data": {
    "students": [
      {
        "id": "uuid",
        "firstName": "Jane",
        "lastName": "Doe",
        "email": "jane@example.com",
        "claimedAt": null,
        "lastClassDate": "2026-03-28T00:00:00Z",
        "classCount": 12
      }
    ],
    "total": 87,
    "page": 1,
    "pageSize": 20
  }
}
```

`lastClassDate` and `classCount` are derived from registrations for this teacher's classes. Null `lastClassDate` means no classes yet.

### `POST /api/students` (modify existing)

Currently creates a student and errors on duplicate email. New behavior:

**Auth:** Teacher session required.

**Body:** `{ firstName, lastName, email }`

**Logic:**
1. Check if a Student with that email already exists
2. If yes: check if a `TeacherStudent` link already exists for this teacher
   - If link exists: return 409 "Student already in your contacts"
   - If no link: create `TeacherStudent` link, return 200 with existing student
3. If no: create Student (with `claimedAt: null`) + `TeacherStudent` link in a transaction, return 201

This means two teachers can independently add the same student by email. When the student claims their account, both teachers see the claimed status.

## Pages

### `/students` — Student List

A hybrid page: server component shell with a client component for the interactive list.

**Server component** (`src/app/(teacher)/students/page.tsx`):
- Renders `PageHeader` with title "Students"
- Renders the client `StudentDirectory` component

**Client component** (`src/components/students/student-directory.tsx`):
- Search input at the top (debounced 300ms, hits `GET /api/students?search=...`)
- Below search: the student list
- Below list: pagination controls
- Initial load fetches page 1 with no search term

**Search input:**
- Placeholder: "Search by name or email"
- Debounced at 300ms — fires API call after the user stops typing
- Resets to page 1 on new search
- Shows a subtle loading indicator while fetching (not a spinner — just muted text opacity)

**Student rows:**
- Same visual pattern as existing `StudentList`: name on left, metadata on right
- Left side: formatted name ("Jane d."), email below in brown/small
- Right side: class count, and if `claimedAt` is null show a small "unlinked" label in muted text
- Each row links to `/students/[id]`

**Pagination controls:**
- Compact mobile-friendly: `< 1 2 3 ... 12 >`
- Previous/next arrows (disabled at bounds)
- Show first page, last page, and up to 3 pages around current
- Ellipsis when there's a gap
- Tappable targets minimum 44px

**Empty states:**
- No students at all: "No students yet. Add your first student."
- No search results: "No students matching '[query]'."

### `/students/new` — Create Student

Simple form page.

**Server component** (`src/app/(teacher)/students/new/page.tsx`):
- `PageHeader` with title "New student" and back link to `/students`
- Client form component

**Form fields:**
- First name (required)
- Last name (required)
- Email (required, validated as email)

**Behavior:**
- Client-side validation before submit
- On submit: POST to `/api/students`
- On success: redirect to `/students/[id]`
- On 409 ("already in your contacts"): show inline error
- On other error: show inline error message

## Component Structure

```
src/
├── app/(teacher)/students/
│   ├── page.tsx                    # Server shell → renders StudentDirectory
│   └── new/
│       └── page.tsx                # Server shell → renders CreateStudentForm
├── components/students/
│   ├── student-directory.tsx       # Client: search + list + pagination
│   ├── student-list.tsx            # Existing (keep for now, used by directory)
│   ├── create-student-form.tsx     # Client: form for creating students
│   └── pagination.tsx              # Reusable pagination controls
```

## Pagination Component

Reusable `Pagination` component in `src/components/students/pagination.tsx`:

**Props:**
- `currentPage: number`
- `totalPages: number`
- `onPageChange: (page: number) => void`

**Rendering logic:**
- Always show first and last page
- Show up to 3 pages around current page
- Ellipsis for gaps
- Previous/next arrows
- All tap targets minimum 44px for mobile

Example renders:
- Page 1 of 12: `< 1 2 3 ... 12 >`
- Page 6 of 12: `< 1 ... 5 6 7 ... 12 >`
- Page 12 of 12: `< 1 ... 10 11 12 >`
- Page 2 of 3: `< 1 2 3 >`

## Validation

Add a Zod schema for the GET query params:

```typescript
const studentListQuerySchema = z.object({
  search: z.string().optional().default(''),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
});
```

The existing `createStudentSchema` already validates firstName, lastName, email. Remove the `incomeTier` field from teacher-initiated creation (teachers don't set a student's income tier — that's the student's choice).

## Out of Scope

- Student-side "see which teachers have you" view
- StudentPrivacy management from student side
- Claiming flow (what happens when a student signs up with an existing email)
- Bulk import/export
- Student detail page changes (existing page works as-is)
