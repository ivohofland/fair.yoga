# Rooms Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add teacher-facing room management pages — list linked rooms, add rooms (with address-based search for existing public rooms), edit teacher-specific settings, and unlink rooms.

**Architecture:** All CRUD APIs already exist. This is primarily UI work: 3 pages and 4 components, plus a small modification to `GET /api/rooms` for search. Server components for pages, client components for forms.

**Tech Stack:** Next.js App Router (pages), React client components (forms), Prisma (one query modification), Zod (search schema)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/schemas.ts` | Modify | Add `roomSearchQuerySchema` |
| `src/app/api/rooms/route.ts` | Modify | Add postcode/street search to GET |
| `src/components/settings/room-list.tsx` | Create | Server component: room rows |
| `src/components/settings/edit-teacher-room-form.tsx` | Create | Client: edit capacity/rate/notes |
| `src/components/settings/unlink-room-button.tsx` | Create | Client: unlink with confirmation |
| `src/components/settings/add-room-flow.tsx` | Create | Client: 2-step search + create + link |
| `src/app/(teacher)/settings/rooms/page.tsx` | Create | Server: rooms list page |
| `src/app/(teacher)/settings/rooms/[id]/page.tsx` | Create | Server: edit teacher room page |
| `src/app/(teacher)/settings/rooms/new/page.tsx` | Create | Server shell: add room flow |

---

### Task 1: Room Search Schema + API

**Files:**
- Modify: `src/lib/schemas.ts`
- Modify: `src/app/api/rooms/route.ts`

- [ ] **Step 1: Add `roomSearchQuerySchema` to schemas**

In `src/lib/schemas.ts`, add after the `updateRoomSchema` export:

```typescript
export const roomSearchQuerySchema = z.object({
  postcode: z.string().optional(),
  street: z.string().optional(),
});
```

- [ ] **Step 2: Modify GET /api/rooms to support search**

Replace the GET handler in `src/app/api/rooms/route.ts` with:

```typescript
export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const { postcode, street } = roomSearchQuerySchema.parse(params);

  // When both postcode and street provided, search public rooms
  if (postcode && street) {
    const rooms = await prisma.room.findMany({
      where: {
        isPublic: true,
        postcode: { equals: postcode, mode: 'insensitive' },
        address: { contains: street, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
    });
    return respondOk(rooms);
  }

  // Default: all public rooms + teacher's private rooms
  const rooms = await prisma.room.findMany({
    where: {
      OR: [{ isPublic: true }, { createdById: session.userId }],
    },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(rooms);
}
```

Add the import for `roomSearchQuerySchema` at the top:

```typescript
import { createRoomSchema, roomSearchQuerySchema } from '@/lib/schemas';
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/schemas.ts src/app/api/rooms/route.ts
git commit -m "feat: add postcode/street search to GET /api/rooms

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Room List Component

**Files:**
- Create: `src/components/settings/room-list.tsx`

- [ ] **Step 1: Create the room list component**

Create `src/components/settings/room-list.tsx`:

```tsx
import Link from 'next/link';
import type { TeacherRoom, Room } from '@prisma/client';

type TeacherRoomWithRoom = TeacherRoom & { room: Room };

interface RoomListProps {
  teacherRooms: TeacherRoomWithRoom[];
}

export function RoomList({ teacherRooms }: RoomListProps) {
  if (teacherRooms.length === 0) {
    return <p className="text-brown text-sm">No rooms yet. Add your first room.</p>;
  }

  return (
    <div>
      {teacherRooms.map((tr) => (
        <Link
          key={tr.id}
          href={`/settings/rooms/${tr.id}`}
          className="flex items-start justify-between py-3 border-b border-border"
        >
          <div className="flex flex-col gap-1">
            <span className="text-dark text-sm font-medium">
              {tr.room.roomName} at {tr.room.venueName}
            </span>
            <span className="text-brown text-xs">
              {tr.room.city} {tr.room.postcode}
            </span>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-brown text-sm">
              {tr.capacityOverride} students
            </span>
            <span className="text-brown text-xs">
              &euro;{Number(tr.rentalRate).toFixed(2)}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/settings/room-list.tsx
git commit -m "feat: add RoomList component

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rooms List Page

**Files:**
- Create: `src/app/(teacher)/settings/rooms/page.tsx`

- [ ] **Step 1: Create the rooms list page**

Create `src/app/(teacher)/settings/rooms/page.tsx`:

```tsx
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { RoomList } from '@/components/settings/room-list';

export default async function RoomsPage() {
  const session = await requireTeacherSession();

  const teacherRooms = await prisma.teacherRoom.findMany({
    where: { teacherId: session.userId },
    include: { room: true },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader
        title="Rooms"
        action={<Link href="/settings/rooms/new" className="text-teal text-sm">+ Add room</Link>}
      />
      <RoomList teacherRooms={teacherRooms} />
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/(teacher)/settings/rooms/page.tsx"
git commit -m "feat: add /settings/rooms list page

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Edit TeacherRoom Form + Unlink Button

**Files:**
- Create: `src/components/settings/edit-teacher-room-form.tsx`
- Create: `src/components/settings/unlink-room-button.tsx`

- [ ] **Step 1: Create the edit form component**

Create `src/components/settings/edit-teacher-room-form.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface EditTeacherRoomFormProps {
  teacherRoomId: string;
  maxCapacity: number;
  initial: {
    capacityOverride: number;
    rentalRate: number;
    equipmentNotes: string;
  };
}

export function EditTeacherRoomForm({
  teacherRoomId,
  maxCapacity,
  initial,
}: EditTeacherRoomFormProps) {
  const router = useRouter();
  const [capacityOverride, setCapacityOverride] = useState(String(initial.capacityOverride));
  const [rentalRate, setRentalRate] = useState(String(initial.rentalRate));
  const [equipmentNotes, setEquipmentNotes] = useState(initial.equipmentNotes);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cap = Number(capacityOverride);
    const rate = Number(rentalRate);

    if (!cap || cap <= 0) {
      setError('Capacity must be a positive number');
      return;
    }
    if (cap > maxCapacity) {
      setError(`Capacity cannot exceed room maximum (${maxCapacity})`);
      return;
    }
    if (isNaN(rate) || rate < 0) {
      setError('Rental rate must be 0 or more');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`/api/teacher-rooms/${teacherRoomId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capacityOverride: cap,
          rentalRate: rate,
          equipmentNotes: equipmentNotes.trim() || null,
        }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to save');
        return;
      }

      setSuccess('Saved');
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label={`Capacity override (max ${maxCapacity})`}
        type="number"
        value={capacityOverride}
        onChange={(e) => { setCapacityOverride(e.target.value); setSuccess(''); }}
      />
      <Input
        label="Rental rate"
        type="number"
        step="0.01"
        value={rentalRate}
        onChange={(e) => { setRentalRate(e.target.value); setSuccess(''); }}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="equipmentNotes" className="text-brown">Equipment notes</label>
        <textarea
          id="equipmentNotes"
          value={equipmentNotes}
          onChange={(e) => { setEquipmentNotes(e.target.value); setSuccess(''); }}
          rows={3}
          className="bg-cream border border-teal rounded-none px-4 py-3 min-h-[44px] text-dark focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--color-teal)] w-full"
        />
      </div>

      {error && <p className="text-sm text-error">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving...' : 'Save'}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Create the unlink button component**

Create `src/components/settings/unlink-room-button.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface UnlinkRoomButtonProps {
  teacherRoomId: string;
  roomName: string;
}

export function UnlinkRoomButton({ teacherRoomId, roomName }: UnlinkRoomButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function handleUnlink() {
    setRemoving(true);
    try {
      const res = await fetch(`/api/teacher-rooms/${teacherRoomId}`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/settings/rooms');
      }
    } finally {
      setRemoving(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-error text-sm"
      >
        Unlink room
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-brown">Unlink {roomName}? Classes using this room will also be removed.</p>
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleUnlink} disabled={removing}>
          {removing ? 'Unlinking...' : 'Unlink'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/edit-teacher-room-form.tsx src/components/settings/unlink-room-button.tsx
git commit -m "feat: add EditTeacherRoomForm and UnlinkRoomButton components

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Edit TeacherRoom Page

**Files:**
- Create: `src/app/(teacher)/settings/rooms/[id]/page.tsx`

- [ ] **Step 1: Create the edit page**

Create `src/app/(teacher)/settings/rooms/[id]/page.tsx`:

```tsx
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { EditTeacherRoomForm } from '@/components/settings/edit-teacher-room-form';
import { UnlinkRoomButton } from '@/components/settings/unlink-room-button';

export default async function EditRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const teacherRoom = await prisma.teacherRoom.findUnique({
    where: { id },
    include: { room: true },
  });

  if (!teacherRoom || teacherRoom.teacherId !== session.userId) {
    redirect('/settings/rooms');
  }

  const { room } = teacherRoom;
  const equipment = Array.isArray(room.equipment) ? (room.equipment as string[]).join(', ') : '';

  return (
    <>
      <PageHeader title={room.roomName} backHref="/settings/rooms" />

      {/* Room base info (read-only) */}
      <section className="mb-8">
        <h2 className="font-heading text-lg font-bold text-teal mb-3">Room details</h2>
        <div className="flex flex-col gap-2">
          <div>
            <span className="text-sm text-brown">Venue</span>
            <p className="text-dark">{room.venueName}</p>
          </div>
          <div>
            <span className="text-sm text-brown">Address</span>
            <p className="text-dark">{room.address}, {room.city} {room.postcode}</p>
          </div>
          <div>
            <span className="text-sm text-brown">Floor</span>
            <p className="text-dark">{room.floor}</p>
          </div>
          <div>
            <span className="text-sm text-brown">Max capacity</span>
            <p className="text-dark">{room.maxCapacity}</p>
          </div>
          {equipment && (
            <div>
              <span className="text-sm text-brown">Equipment</span>
              <p className="text-dark">{equipment}</p>
            </div>
          )}
        </div>
      </section>

      {/* Teacher-specific settings (editable) */}
      <section className="mb-8">
        <h2 className="font-heading text-lg font-bold text-teal mb-3">Your settings</h2>
        <EditTeacherRoomForm
          teacherRoomId={teacherRoom.id}
          maxCapacity={room.maxCapacity}
          initial={{
            capacityOverride: teacherRoom.capacityOverride,
            rentalRate: Number(teacherRoom.rentalRate),
            equipmentNotes: teacherRoom.equipmentNotes ?? '',
          }}
        />
      </section>

      {/* Unlink */}
      <section className="pt-6 border-t border-border">
        <UnlinkRoomButton
          teacherRoomId={teacherRoom.id}
          roomName={`${room.roomName} at ${room.venueName}`}
        />
      </section>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/(teacher)/settings/rooms/[id]/page.tsx"
git commit -m "feat: add /settings/rooms/[id] edit page

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Add Room Flow Component

**Files:**
- Create: `src/components/settings/add-room-flow.tsx`

- [ ] **Step 1: Create the add room flow component**

Create `src/components/settings/add-room-flow.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface RoomResult {
  id: string;
  venueName: string;
  roomName: string;
  address: string;
  city: string;
  postcode: string;
  floor: string;
  maxCapacity: number;
}

type Step = 'search' | 'create' | 'settings';

export function AddRoomFlow() {
  const router = useRouter();

  // Search state
  const [postcode, setPostcode] = useState('');
  const [street, setStreet] = useState('');
  const [results, setResults] = useState<RoomResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Selected or newly created room
  const [selectedRoom, setSelectedRoom] = useState<RoomResult | null>(null);

  // Create room state
  const [venueName, setVenueName] = useState('');
  const [roomName, setRoomName] = useState('');
  const [floor, setFloor] = useState('');
  const [city, setCity] = useState('');
  const [maxCapacity, setMaxCapacity] = useState('');
  const [equipment, setEquipment] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  // Settings state
  const [capacityOverride, setCapacityOverride] = useState('');
  const [rentalRate, setRentalRate] = useState('');
  const [equipmentNotes, setEquipmentNotes] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [saving, setSaving] = useState(false);

  const [step, setStep] = useState<Step>('search');

  // ---- Search ----

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!postcode.trim() || !street.trim()) return;

    setSearching(true);
    setResults(null);
    try {
      const params = new URLSearchParams({
        postcode: postcode.trim(),
        street: street.trim(),
      });
      const res = await fetch(`/api/rooms?${params}`);
      if (!res.ok) return;
      const json: { data: RoomResult[] } = await res.json();
      setResults(json.data);
    } finally {
      setSearching(false);
    }
  }

  function handleSelectRoom(room: RoomResult) {
    setSelectedRoom(room);
    setCapacityOverride(String(room.maxCapacity));
    setStep('settings');
  }

  function handleCreateNew() {
    setStep('create');
  }

  // ---- Create Room ----

  async function handleCreateRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!venueName.trim() || !roomName.trim() || !floor.trim() || !city.trim()) {
      setCreateError('All fields except equipment are required');
      return;
    }
    const cap = Number(maxCapacity);
    if (!cap || cap <= 0) {
      setCreateError('Max capacity must be a positive number');
      return;
    }

    setCreating(true);
    setCreateError('');

    try {
      const equipmentArray = equipment.trim()
        ? equipment.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueName: venueName.trim(),
          address: street.trim(),
          city: city.trim(),
          postcode: postcode.trim(),
          floor: floor.trim(),
          roomName: roomName.trim(),
          maxCapacity: cap,
          equipment: equipmentArray,
        }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setCreateError(json.error?.message ?? 'Failed to create room');
        return;
      }

      const json: { data: RoomResult } = await res.json();
      setSelectedRoom(json.data);
      setCapacityOverride(String(cap));
      setStep('settings');
    } catch {
      setCreateError('Network error. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  // ---- Link (Settings) ----

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedRoom) return;

    const cap = Number(capacityOverride);
    const rate = Number(rentalRate);

    if (!cap || cap <= 0) {
      setSettingsError('Capacity must be a positive number');
      return;
    }
    if (cap > selectedRoom.maxCapacity) {
      setSettingsError(`Capacity cannot exceed room maximum (${selectedRoom.maxCapacity})`);
      return;
    }
    if (isNaN(rate) || rate < 0) {
      setSettingsError('Rental rate must be 0 or more');
      return;
    }

    setSaving(true);
    setSettingsError('');

    try {
      const res = await fetch('/api/teacher-rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: selectedRoom.id,
          capacityOverride: cap,
          rentalRate: rate,
          equipmentNotes: equipmentNotes.trim() || null,
        }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setSettingsError(json.error?.message ?? 'Failed to link room');
        return;
      }

      router.push('/settings/rooms');
    } catch {
      setSettingsError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // ---- Render ----

  return (
    <div>
      {/* Step 1: Search */}
      {step === 'search' && (
        <>
          <form onSubmit={handleSearch} className="flex flex-col gap-4 mb-6">
            <Input
              label="Postcode"
              value={postcode}
              onChange={(e) => setPostcode(e.target.value)}
              placeholder="e.g. 1018 DT"
            />
            <Input
              label="Street"
              value={street}
              onChange={(e) => setStreet(e.target.value)}
              placeholder="e.g. Keizersgracht"
            />
            <Button type="submit" disabled={searching || !postcode.trim() || !street.trim()}>
              {searching ? 'Searching...' : 'Search'}
            </Button>
          </form>

          {results !== null && (
            <div>
              {results.length > 0 ? (
                <>
                  <p className="text-sm text-brown mb-3">Existing rooms found:</p>
                  <div className="mb-4">
                    {results.map((room) => (
                      <button
                        key={room.id}
                        type="button"
                        onClick={() => handleSelectRoom(room)}
                        className="w-full text-left flex flex-col gap-1 py-3 border-b border-border"
                      >
                        <span className="text-dark text-sm font-medium">
                          {room.roomName} at {room.venueName}
                        </span>
                        <span className="text-brown text-xs">{room.address}, {room.city}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={handleCreateNew}
                    className="text-teal text-sm"
                  >
                    Or create a new room at this address
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm text-brown mb-3">No rooms found at this address.</p>
                  <button
                    type="button"
                    onClick={handleCreateNew}
                    className="text-teal text-sm"
                  >
                    Create new room
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Step 1b: Create new room */}
      {step === 'create' && (
        <form onSubmit={handleCreateRoom} className="flex flex-col gap-4">
          <Input label="Venue name" value={venueName} onChange={(e) => setVenueName(e.target.value)} placeholder="e.g. De Yogaschool" />
          <Input label="Address" value={street} onChange={(e) => setStreet(e.target.value)} />
          <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
          <Input label="Postcode" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
          <Input label="Floor" value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="e.g. Ground, 1st" />
          <Input label="Room name" value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="e.g. Main Studio" />
          <Input label="Max capacity" type="number" value={maxCapacity} onChange={(e) => setMaxCapacity(e.target.value)} />
          <Input label="Equipment (comma-separated)" value={equipment} onChange={(e) => setEquipment(e.target.value)} placeholder="e.g. mats, blocks, straps" />

          {createError && <p className="text-sm text-error">{createError}</p>}

          <div className="flex justify-between mt-4">
            <Button variant="secondary" type="button" onClick={() => setStep('search')}>
              Back
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? 'Creating...' : 'Create room'}
            </Button>
          </div>
        </form>
      )}

      {/* Step 2: Your settings */}
      {step === 'settings' && selectedRoom && (
        <>
          <div className="mb-6 pb-4 border-b border-border">
            <p className="text-dark text-sm font-medium">
              {selectedRoom.roomName} at {selectedRoom.venueName}
            </p>
            <p className="text-brown text-xs">{selectedRoom.address}, {selectedRoom.city}</p>
          </div>

          <form onSubmit={handleSaveSettings} className="flex flex-col gap-4">
            <Input
              label={`Capacity override (max ${selectedRoom.maxCapacity})`}
              type="number"
              value={capacityOverride}
              onChange={(e) => setCapacityOverride(e.target.value)}
            />
            <Input
              label="Rental rate"
              type="number"
              step="0.01"
              value={rentalRate}
              onChange={(e) => setRentalRate(e.target.value)}
            />
            <Input
              label="Equipment notes (optional)"
              value={equipmentNotes}
              onChange={(e) => setEquipmentNotes(e.target.value)}
            />

            {settingsError && <p className="text-sm text-error">{settingsError}</p>}

            <div className="flex justify-between mt-4">
              <Button variant="secondary" type="button" onClick={() => { setSelectedRoom(null); setStep('search'); }}>
                Back
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Add room'}
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/settings/add-room-flow.tsx
git commit -m "feat: add AddRoomFlow component with search, create, and link steps

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Add Room Page

**Files:**
- Create: `src/app/(teacher)/settings/rooms/new/page.tsx`

- [ ] **Step 1: Create the add room page**

Create `src/app/(teacher)/settings/rooms/new/page.tsx`:

```tsx
import { PageHeader } from '@/components/layout/page-header';
import { AddRoomFlow } from '@/components/settings/add-room-flow';

export default function NewRoomPage() {
  return (
    <>
      <PageHeader title="Add room" backHref="/settings/rooms" />
      <AddRoomFlow />
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/(teacher)/settings/rooms/new/page.tsx"
git commit -m "feat: add /settings/rooms/new page

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Build + Lint Check

- [ ] **Step 1: Run TypeScript build check**

Run: `npx next build`

Expected: Build succeeds with no type errors.

- [ ] **Step 2: Run ESLint**

Run: `npx eslint src/ --max-warnings 0`

Expected: No errors or warnings.

- [ ] **Step 3: Fix any issues found**

If build or lint fails, fix the issues and commit.
