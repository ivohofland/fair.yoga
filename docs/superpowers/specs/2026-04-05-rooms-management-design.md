# Rooms Management — Design Spec

Teacher-facing room management: list linked rooms, add new rooms (with address-based search for existing public rooms), edit teacher-specific settings, and unlink.

## Concepts

- **Room** — shared venue record (address, venue name, room name, max capacity, equipment). Public rooms are visible to all teachers. Base properties are read-only after creation.
- **TeacherRoom** — teacher's personal link to a room. Contains their capacity override, private rental rate, and equipment notes. Each teacher manages their own.

## Pages

### `/settings/rooms` — Rooms List

Server component. Lists the teacher's TeacherRooms.

**Data:** `GET /api/teacher-rooms` (already exists, returns TeacherRooms with included room data).

**Layout:**
- `PageHeader` with title "Rooms" and `+ Add room` action linking to `/settings/rooms/new`
- List of rooms, each row showing:
  - Room name + venue name (e.g. "Main Studio at De Yogaschool")
  - Address (city + postcode)
  - Capacity override and rental rate
- Each row links to `/settings/rooms/[id]`
- Empty state: "No rooms yet. Add your first room."

### `/settings/rooms/[id]` — Edit TeacherRoom

Server component with client form.

**Data:** `GET /api/teacher-rooms/[id]` (already exists, includes room data).

**Layout:**
- `PageHeader` with title showing room name
- Read-only section showing room base info:
  - Venue name, address, city, postcode, floor
  - Max capacity, equipment list
- Editable form for TeacherRoom settings:
  - Capacity override (number, must be <= room max capacity)
  - Rental rate (number, >= 0)
  - Equipment notes (optional text)
- Save button → `PUT /api/teacher-rooms/[id]`
- "Unlink room" at the bottom → `DELETE /api/teacher-rooms/[id]` with confirmation, redirects to `/settings/rooms`

### `/settings/rooms/new` — Add Room (2-step flow)

Client component with two steps.

**Step 1: Find or create room**

Search section:
- Postcode input (required)
- Street input (required)
- Search button → `GET /api/rooms?postcode=...&street=...`

Results:
- If matches found: flat list showing "Room Name at Venue Name — Address". Teacher picks one → proceed to step 2.
- If no matches (or teacher wants to create new): show "No rooms found at this address" with a "Create new room" button that expands the full room creation form:
  - Venue name (required)
  - Address (pre-filled from search input)
  - City (required)
  - Postcode (pre-filled from search input)
  - Floor (required)
  - Room name (required)
  - Max capacity (required, positive integer)
  - Equipment (optional, comma-separated text converted to JSON array)
- On create: `POST /api/rooms` → proceed to step 2 with the new room.

**Step 2: Your settings**

- Capacity override (number, pre-filled with room's max capacity)
- Rental rate (number, required, >= 0)
- Equipment notes (optional)
- Save button → `POST /api/teacher-rooms` with `{ roomId, capacityOverride, rentalRate, equipmentNotes }`
- On success: redirect to `/settings/rooms`

## API Changes

### Modify `GET /api/rooms`

Add optional search query params. When both `postcode` and `street` are provided, filter to public rooms where:
- `postcode` matches exactly (case-insensitive)
- `address` contains the `street` term (case-insensitive)

When no search params provided, existing behavior unchanged (return all public rooms + teacher's private rooms).

Add Zod schema for the query params:

```typescript
export const roomSearchQuerySchema = z.object({
  postcode: z.string().optional(),
  street: z.string().optional(),
});
```

## Component Structure

```
src/
├── app/(teacher)/settings/rooms/
│   ├── page.tsx                     # Server: rooms list
│   ├── [id]/
│   │   └── page.tsx                 # Server shell + client edit form
│   └── new/
│       └── page.tsx                 # Server shell + client add flow
├── components/settings/
│   ├── room-list.tsx                # Room list display
│   ├── edit-teacher-room-form.tsx   # Client: edit capacity/rate/notes
│   ├── add-room-flow.tsx            # Client: 2-step search + create + link
│   └── unlink-room-button.tsx       # Client: unlink with confirmation
```

## Out of Scope

- Room base property editing (read-only after creation, changes via admin only)
- "Suggest changes" feature for room base properties
- Map-based room search
- Room photo upload
- Equipment as structured data (kept as simple comma-separated text / JSON array)
