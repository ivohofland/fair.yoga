# Recurring Classes Management — Design Spec

Teacher-facing management of class templates: list recurring classes, create new templates, edit template settings, and pause/resume.

## Concepts

- **ClassTemplate** — a blueprint for recurring classes. Defines the day of week, time, room, pricing, and policies. Active templates generate Class instances on a rolling 4-week basis.
- **Class (instance)** — an individual occurrence generated from a template. Once generated, instances are independent — editing the template only affects future instances.

## Pages

### `/settings/recurring` — Recurring Classes List

Server component. Lists the teacher's class templates.

**Data:** `GET /api/class-templates` (already exists, returns all templates for the teacher).

**Layout:**
- `PageHeader` with title "Recurring classes" and `+ Add` action linking to `/settings/recurring/new`
- Active templates listed first, then paused templates below with a visual distinction
- Each row shows:
  - Class type (e.g. "Vinyasa")
  - Day + time (e.g. "Tuesday 09:00")
  - Room name (need to include room in the API response)
  - Duration
  - Status indicator: active or paused
- Each row links to `/settings/recurring/[id]`
- Empty state: "No recurring classes yet."

### `/settings/recurring/[id]` — Edit Template

Server component with client form.

**Data:** `GET /api/class-templates/[id]` (already exists). Need to include `teacherRoom.room` for display.

**Layout:**
- `PageHeader` with title showing class type
- Editable form with all template fields:
  - Class type (text)
  - Description (optional textarea)
  - Room (dropdown of teacher's active TeacherRooms)
  - Day of week (dropdown: Monday–Sunday)
  - Start time (time input)
  - Duration in minutes (number)
  - Room cost (number, pre-filled from selected room's rental rate)
  - Min rate (number, can be negative)
  - Target rate (number)
  - Min students (number)
  - Max students (number, capped at room capacity)
  - Cancellation deadline (dropdown)
  - Auto-cancel check (dropdown)
- Save button → `PUT /api/class-templates/[id]`
- Pause/resume toggle at the bottom → `DELETE /api/class-templates/[id]` (sets isActive: false) or a new reactivate endpoint
- Pricing preview table (reuse existing `PricingPreviewTable` component)

### `/settings/recurring/new` — Create Template

Server component with client form.

**Layout:**
- `PageHeader` with title "New recurring class" and back link to `/settings/recurring`
- Same form fields as edit page
- On save → `POST /api/class-templates`, then redirect to `/settings/recurring`

## API Changes

### Modify `GET /api/class-templates`

Include TeacherRoom with Room data so the list can display room names:

```typescript
include: { teacherRoom: { include: { room: true } } }
```

### Modify `GET /api/class-templates/[id]`

Same include for the detail page.

### Add reactivate endpoint

The existing `DELETE /api/class-templates/[id]` sets `isActive: false`. Add a `PATCH /api/class-templates/[id]` to toggle `isActive`:

```typescript
export async function PATCH(...) {
  // Toggle isActive
  const updated = await prisma.classTemplate.update({
    where: { id },
    data: { isActive: !template.isActive },
  });
  return respondOk(updated);
}
```

## Component Structure

```
src/
├── app/(teacher)/settings/recurring/
│   ├── page.tsx                        # Server: template list
│   ├── [id]/
│   │   └── page.tsx                    # Server shell + client edit form
│   └── new/
│       └── page.tsx                    # Server shell + client create form
├── components/settings/
│   ├── template-list.tsx               # Template list display
│   ├── template-form.tsx               # Client: shared create/edit form
│   └── toggle-template-button.tsx      # Client: pause/resume toggle
```

The form component is shared between create and edit — it takes optional `initial` values (populated for edit, empty for create) and a `mode` prop ('create' | 'edit') to determine which API endpoint to call.

## Day of Week Display

Schema uses 0=Monday through 6=Sunday. Display labels:

```typescript
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
```

## Out of Scope

- Instance-vs-template editing (belongs on class detail page)
- Automatic generation trigger (cron job / scheduled task)
- Manual "generate now" button
- Template history / changelog
