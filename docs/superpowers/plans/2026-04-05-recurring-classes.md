# Recurring Classes Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add teacher-facing management pages for class templates — list, create, edit, and pause/resume recurring classes.

**Architecture:** All CRUD APIs already exist. Modify GET endpoints to include room data, add a PATCH endpoint for toggle. UI: 3 pages, 3 components. Shared form component for create and edit.

**Tech Stack:** Next.js App Router (pages), React client components (form, toggle), existing PricingPreviewTable component

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/app/api/class-templates/route.ts` | Modify | Include teacherRoom.room in GET |
| `src/app/api/class-templates/[id]/route.ts` | Modify | Include teacherRoom.room in GET, add PATCH toggle |
| `src/components/settings/template-list.tsx` | Create | Template list display |
| `src/components/settings/template-form.tsx` | Create | Shared create/edit form |
| `src/components/settings/toggle-template-button.tsx` | Create | Pause/resume toggle |
| `src/app/(teacher)/settings/recurring/page.tsx` | Create | Template list page |
| `src/app/(teacher)/settings/recurring/[id]/page.tsx` | Create | Edit template page |
| `src/app/(teacher)/settings/recurring/new/page.tsx` | Create | Create template page |

---

### Task 1: API Changes

**Files:**
- Modify: `src/app/api/class-templates/route.ts`
- Modify: `src/app/api/class-templates/[id]/route.ts`

- [ ] **Step 1: Add room include to GET /api/class-templates**

In `src/app/api/class-templates/route.ts`, change the `findMany` call to include room data:

```typescript
  const templates = await prisma.classTemplate.findMany({
    where: { teacherId: session.userId },
    include: { teacherRoom: { include: { room: true } } },
    orderBy: { createdAt: 'desc' },
  });
```

- [ ] **Step 2: Add room include to GET /api/class-templates/[id]**

In `src/app/api/class-templates/[id]/route.ts`, change the `findUnique` in the GET handler to:

```typescript
  const template = await prisma.classTemplate.findUnique({
    where: { id },
    include: { teacherRoom: { include: { room: true } } },
  });
```

- [ ] **Step 3: Add PATCH handler for toggle isActive**

In `src/app/api/class-templates/[id]/route.ts`, add after the DELETE handler:

```typescript
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.classTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Class template not found', 404);

  if (template.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  const updated = await prisma.classTemplate.update({
    where: { id },
    data: { isActive: !template.isActive },
  });

  return respondOk(updated);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/class-templates/route.ts "src/app/api/class-templates/[id]/route.ts"
git commit -m "feat: add room include to class template GETs, add PATCH toggle

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Template List Component

**Files:**
- Create: `src/components/settings/template-list.tsx`

- [ ] **Step 1: Create the template list component**

Create `src/components/settings/template-list.tsx`:

```tsx
import Link from 'next/link';
import type { ClassTemplate, TeacherRoom, Room } from '@prisma/client';

type TemplateWithRoom = ClassTemplate & {
  teacherRoom: TeacherRoom & { room: Room };
};

interface TemplateListProps {
  templates: TemplateWithRoom[];
}

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function TemplateList({ templates }: TemplateListProps) {
  if (templates.length === 0) {
    return <p className="text-brown text-sm">No recurring classes yet.</p>;
  }

  const active = templates.filter((t) => t.isActive);
  const paused = templates.filter((t) => !t.isActive);

  return (
    <div>
      {active.map((t) => (
        <Link
          key={t.id}
          href={`/settings/recurring/${t.id}`}
          className="flex items-start justify-between py-3 border-b border-border"
        >
          <div className="flex flex-col gap-1">
            <span className="text-dark text-sm font-medium">{t.classType}</span>
            <span className="text-brown text-xs">
              {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
            </span>
            <span className="text-brown text-xs">
              {t.teacherRoom.room.roomName
                ? `${t.teacherRoom.room.roomName} at ${t.teacherRoom.room.venueName}`
                : t.teacherRoom.room.venueName}
            </span>
          </div>
          <span className="text-teal text-xs pt-1">active</span>
        </Link>
      ))}

      {paused.length > 0 && (
        <>
          {active.length > 0 && <div className="py-3" />}
          {paused.map((t) => (
            <Link
              key={t.id}
              href={`/settings/recurring/${t.id}`}
              className="flex items-start justify-between py-3 border-b border-border opacity-60"
            >
              <div className="flex flex-col gap-1">
                <span className="text-dark text-sm font-medium">{t.classType}</span>
                <span className="text-brown text-xs">
                  {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
                </span>
                <span className="text-brown text-xs">
                  {t.teacherRoom.room.roomName
                    ? `${t.teacherRoom.room.roomName} at ${t.teacherRoom.room.venueName}`
                    : t.teacherRoom.room.venueName}
                </span>
              </div>
              <span className="text-brown text-xs pt-1">paused</span>
            </Link>
          ))}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/settings/template-list.tsx
git commit -m "feat: add TemplateList component

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Template List Page

**Files:**
- Create: `src/app/(teacher)/settings/recurring/page.tsx`

- [ ] **Step 1: Create the recurring classes list page**

Create `src/app/(teacher)/settings/recurring/page.tsx`:

```tsx
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateList } from '@/components/settings/template-list';

export default async function RecurringClassesPage() {
  const session = await requireTeacherSession();

  const templates = await prisma.classTemplate.findMany({
    where: { teacherId: session.userId },
    include: { teacherRoom: { include: { room: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader
        title="Recurring classes"
        action={<Link href="/settings/recurring/new" className="text-teal text-sm">+ Add</Link>}
      />
      <TemplateList templates={templates} />
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/(teacher)/settings/recurring/page.tsx"
git commit -m "feat: add /settings/recurring list page

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Template Form Component

**Files:**
- Create: `src/components/settings/template-form.tsx`

- [ ] **Step 1: Create the shared template form component**

Create `src/components/settings/template-form.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PricingPreviewTable } from '@/components/class/pricing-preview-table';

interface TeacherRoomOption {
  id: string;
  capacityOverride: number;
  rentalRate: number | string;
  room: { roomName: string; venueName: string };
}

interface TemplateFormProps {
  mode: 'create' | 'edit';
  templateId?: string;
  initial?: {
    teacherRoomId: string;
    classType: string;
    description: string;
    dayOfWeek: number;
    startTime: string;
    durationMinutes: number;
    roomCost: number;
    minRate: number;
    targetRate: number;
    minStudents: number;
    maxStudents: number;
    cancelDeadline: string;
    autoCancelCheck: string;
  };
}

const DAY_OPTIONS = [
  { value: 0, label: 'Monday' },
  { value: 1, label: 'Tuesday' },
  { value: 2, label: 'Wednesday' },
  { value: 3, label: 'Thursday' },
  { value: 4, label: 'Friday' },
  { value: 5, label: 'Saturday' },
  { value: 6, label: 'Sunday' },
];

const CANCEL_DEADLINE_OPTIONS = [
  { value: 'HOURS_48', label: '48 hours' },
  { value: 'HOURS_24', label: '24 hours' },
  { value: 'HOURS_12', label: '12 hours' },
  { value: 'HOURS_6', label: '6 hours' },
];

const AUTO_CANCEL_OPTIONS = [
  { value: 'HOURS_4', label: '4 hours before' },
  { value: 'HOURS_2', label: '2 hours before' },
  { value: 'HOURS_1', label: '1 hour before' },
];

const selectClass =
  'bg-cream border border-teal rounded-none px-4 pr-10 py-3 min-h-[44px] text-dark focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--color-teal)] w-full appearance-none bg-[length:16px_16px] bg-[position:right_12px_center] bg-no-repeat bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%236B5B4E%27%20stroke-width%3D%272%27%3E%3Cpath%20d%3D%27M6%209l6%206%206-6%27/%3E%3C/svg%3E")]';

const INITIAL_VALUES = {
  teacherRoomId: '',
  classType: '',
  description: '',
  dayOfWeek: 0,
  startTime: '09:00',
  durationMinutes: 75,
  roomCost: 0,
  minRate: 15,
  targetRate: 25,
  minStudents: 4,
  maxStudents: 12,
  cancelDeadline: 'HOURS_24',
  autoCancelCheck: 'HOURS_2',
};

export function TemplateForm({ mode, templateId, initial }: TemplateFormProps) {
  const router = useRouter();
  const [form, setForm] = useState(initial ?? INITIAL_VALUES);
  const [teacherRooms, setTeacherRooms] = useState<TeacherRoomOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function fetchRooms() {
      try {
        const res = await fetch('/api/teacher-rooms');
        if (!res.ok) return;
        const json: { data: TeacherRoomOption[] } = await res.json();
        setTeacherRooms(json.data);
      } finally {
        setLoading(false);
      }
    }
    void fetchRooms();
  }, []);

  const selectedRoom = teacherRooms.find((tr) => tr.id === form.teacherRoomId);
  const roomCapacity = selectedRoom?.capacityOverride ?? 30;

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSuccess('');
  }

  function handleRoomChange(teacherRoomId: string) {
    const room = teacherRooms.find((tr) => tr.id === teacherRoomId);
    setForm((prev) => ({
      ...prev,
      teacherRoomId,
      roomCost: room ? Number(room.rentalRate) : prev.roomCost,
      maxStudents: room ? Math.min(prev.maxStudents, room.capacityOverride) : prev.maxStudents,
    }));
    setSuccess('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.teacherRoomId) {
      setError('Select a room');
      return;
    }
    if (!form.classType.trim()) {
      setError('Class type is required');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const url = mode === 'create'
        ? '/api/class-templates'
        : `/api/class-templates/${templateId}`;
      const method = mode === 'create' ? 'POST' : 'PUT';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teacherRoomId: form.teacherRoomId,
          classType: form.classType.trim(),
          description: form.description.trim() || null,
          dayOfWeek: form.dayOfWeek,
          startTime: form.startTime,
          durationMinutes: form.durationMinutes,
          roomCost: form.roomCost,
          minRate: form.minRate,
          targetRate: form.targetRate,
          minStudents: form.minStudents,
          maxStudents: form.maxStudents,
          cancelDeadline: form.cancelDeadline,
          autoCancelCheck: form.autoCancelCheck,
        }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to save');
        return;
      }

      if (mode === 'create') {
        router.push('/settings/recurring');
      } else {
        setSuccess('Saved');
        router.refresh();
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="py-12 text-center text-brown">Loading rooms...</div>;
  }

  if (teacherRooms.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-brown mb-4">No rooms configured.</p>
        <p className="text-sm text-brown">Add a room in Settings before creating a recurring class.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="Class type"
        value={form.classType}
        onChange={(e) => update('classType', e.target.value)}
        placeholder="e.g. Vinyasa, Hatha, Yin"
      />

      <div className="flex flex-col gap-1">
        <label htmlFor="description" className="text-brown">Description</label>
        <textarea
          id="description"
          value={form.description}
          onChange={(e) => update('description', e.target.value)}
          rows={3}
          placeholder="Optional class description"
          className="bg-cream border border-teal rounded-none px-4 py-3 min-h-[44px] text-dark focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--color-teal)] w-full"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="room" className="text-brown">Room</label>
        <select
          id="room"
          className={selectClass}
          value={form.teacherRoomId}
          onChange={(e) => handleRoomChange(e.target.value)}
        >
          <option value="">Select a room</option>
          {teacherRooms.map((tr) => (
            <option key={tr.id} value={tr.id}>
              {tr.room.roomName ? `${tr.room.roomName} at ${tr.room.venueName}` : tr.room.venueName}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="dayOfWeek" className="text-brown">Day</label>
        <select
          id="dayOfWeek"
          className={selectClass}
          value={form.dayOfWeek}
          onChange={(e) => update('dayOfWeek', Number(e.target.value))}
        >
          {DAY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <Input
        label="Start time"
        type="time"
        value={form.startTime}
        onChange={(e) => update('startTime', e.target.value)}
      />

      <Input
        label="Duration (minutes)"
        type="number"
        value={String(form.durationMinutes)}
        onChange={(e) => update('durationMinutes', Number(e.target.value))}
      />

      <Input
        label="Room cost"
        type="number"
        step="0.01"
        value={String(form.roomCost)}
        onChange={(e) => update('roomCost', Number(e.target.value))}
      />

      <Input
        label="Min rate (at min students)"
        type="number"
        step="0.01"
        value={String(form.minRate)}
        onChange={(e) => update('minRate', Number(e.target.value))}
      />

      <Input
        label="Target rate (at max students)"
        type="number"
        step="0.01"
        value={String(form.targetRate)}
        onChange={(e) => update('targetRate', Number(e.target.value))}
      />

      <Input
        label="Min students"
        type="number"
        value={String(form.minStudents)}
        onChange={(e) => update('minStudents', Number(e.target.value))}
      />

      <Input
        label={`Max students (room capacity: ${roomCapacity})`}
        type="number"
        value={String(form.maxStudents)}
        onChange={(e) => update('maxStudents', Math.min(Number(e.target.value), roomCapacity))}
      />

      <PricingPreviewTable
        roomCost={form.roomCost}
        minRate={form.minRate}
        targetRate={form.targetRate}
        minStudents={form.minStudents}
        maxStudents={form.maxStudents}
      />

      <div className="flex flex-col gap-1">
        <label htmlFor="cancelDeadline" className="text-brown">Cancellation deadline</label>
        <select
          id="cancelDeadline"
          className={selectClass}
          value={form.cancelDeadline}
          onChange={(e) => update('cancelDeadline', e.target.value)}
        >
          {CANCEL_DEADLINE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="autoCancelCheck" className="text-brown">Auto-cancel check</label>
        <select
          id="autoCancelCheck"
          className={selectClass}
          value={form.autoCancelCheck}
          onChange={(e) => update('autoCancelCheck', e.target.value)}
        >
          {AUTO_CANCEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/settings/template-form.tsx
git commit -m "feat: add shared TemplateForm component for create/edit

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Toggle Template Button

**Files:**
- Create: `src/components/settings/toggle-template-button.tsx`

- [ ] **Step 1: Create the toggle button component**

Create `src/components/settings/toggle-template-button.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ToggleTemplateButtonProps {
  templateId: string;
  isActive: boolean;
}

export function ToggleTemplateButton({ templateId, isActive }: ToggleTemplateButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/class-templates/${templateId}`, { method: 'PATCH' });
      if (res.ok) {
        router.push('/settings/recurring');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={loading}
      className="text-brown text-sm opacity-60"
    >
      {loading
        ? (isActive ? 'Pausing...' : 'Resuming...')
        : (isActive ? 'Pause recurring class' : 'Resume recurring class')}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/settings/toggle-template-button.tsx
git commit -m "feat: add ToggleTemplateButton for pause/resume

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Edit Template Page

**Files:**
- Create: `src/app/(teacher)/settings/recurring/[id]/page.tsx`

- [ ] **Step 1: Create the edit template page**

Create `src/app/(teacher)/settings/recurring/[id]/page.tsx`:

```tsx
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateForm } from '@/components/settings/template-form';
import { ToggleTemplateButton } from '@/components/settings/toggle-template-button';

export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const template = await prisma.classTemplate.findUnique({
    where: { id },
    include: { teacherRoom: { include: { room: true } } },
  });

  if (!template || template.teacherId !== session.userId) {
    redirect('/settings/recurring');
  }

  return (
    <>
      <PageHeader title={template.classType} backHref="/settings/recurring" />

      <TemplateForm
        mode="edit"
        templateId={template.id}
        initial={{
          teacherRoomId: template.teacherRoomId,
          classType: template.classType,
          description: template.description ?? '',
          dayOfWeek: template.dayOfWeek,
          startTime: template.startTime,
          durationMinutes: template.durationMinutes,
          roomCost: Number(template.roomCost),
          minRate: Number(template.minRate),
          targetRate: Number(template.targetRate),
          minStudents: template.minStudents,
          maxStudents: template.maxStudents,
          cancelDeadline: template.cancelDeadline,
          autoCancelCheck: template.autoCancelCheck,
        }}
      />

      <section className="mt-8 pt-6 border-t border-border">
        <ToggleTemplateButton templateId={template.id} isActive={template.isActive} />
      </section>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/(teacher)/settings/recurring/[id]/page.tsx"
git commit -m "feat: add /settings/recurring/[id] edit page

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Create Template Page

**Files:**
- Create: `src/app/(teacher)/settings/recurring/new/page.tsx`

- [ ] **Step 1: Create the new template page**

Create `src/app/(teacher)/settings/recurring/new/page.tsx`:

```tsx
import { PageHeader } from '@/components/layout/page-header';
import { TemplateForm } from '@/components/settings/template-form';

export default function NewTemplatePage() {
  return (
    <>
      <PageHeader title="New recurring class" backHref="/settings/recurring" />
      <TemplateForm mode="create" />
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/(teacher)/settings/recurring/new/page.tsx"
git commit -m "feat: add /settings/recurring/new page

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

- [ ] **Step 3: Fix any issues found and commit**
