'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { createClassTemplateSchema, updateClassTemplateSchema } from '@/lib/schemas';
import type { CancelDeadline, AutoCancelCheck } from '@prisma/client';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { SettledNotice } from '@/components/ui/settled-notice';
import { PricingPreviewTable } from '@/components/class/pricing-preview-table';
import { formatRoomLocation } from '@/lib/format';
import { CANCEL_DEADLINE_OPTIONS, AUTO_CANCEL_OPTIONS } from '@/lib/class-options';

interface TeacherRoomOption {
  id: string;
  capacityOverride: number;
  rentalRate: number | string;
  room: { roomName: string; venueName: string };
}

/**
 * #85. The one enumeration of this form's fields. It replaced three that
 * nothing reconciled: this prop's inline type, `INITIAL_VALUES`, and the
 * request body. The pins below hold it against the wire schema.
 */
interface TemplateFormValues {
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
  cancelDeadline: CancelDeadline;
  autoCancelCheck: AutoCancelCheck;
}

type UpdateTemplateWire = z.infer<typeof updateClassTemplateSchema>;
type CreateTemplateWire = z.infer<typeof createClassTemplateSchema>;

/**
 * #85. Both schemas, both directions — four pins, because this form sends one
 * body to both endpoints.
 *
 * The issue warned that a pin "has to target the right schema per branch"
 * because create and update differ — they do differ, in optionality and
 * `.strict()`, but not in *keys*: thirteen each, the same thirteen. For a
 * key-set pin they are interchangeable as things stand. The day their keys
 * diverge, that single body stops satisfying one of them, and a pin against
 * only the other would not notice.
 *
 * Forward (`_formCovers…`): a key the schema has and the form does not — a
 * field that looks shipped with no input rendered for it.
 *
 * Reverse (`_formHasNoExtras…`): a key the form sends and the schema dropped.
 * The two endpoints punish that differently, which is why both are pinned
 * rather than just the update one: `updateClassTemplateSchema` is `.strict()`
 * and would 400 the extra key, while `createClassTemplateSchema` is not, so it
 * would *silently strip* it — the field-vanishes-without-a-word mode this
 * change exists to eliminate. Compile time catches both.
 */
const _formCoversUpdate: NoneOf<Exclude<keyof UpdateTemplateWire, keyof TemplateFormValues>> = true;
const _formCoversCreate: NoneOf<Exclude<keyof CreateTemplateWire, keyof TemplateFormValues>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof TemplateFormValues, keyof UpdateTemplateWire>> = true;
const _formHasNoExtrasOnCreate: NoneOf<Exclude<keyof TemplateFormValues, keyof CreateTemplateWire>> = true;
void _formCoversUpdate;
void _formCoversCreate;
void _formHasNoExtras;
void _formHasNoExtrasOnCreate;

interface TemplateFormProps {
  mode: 'create' | 'edit';
  templateId?: string;
  initial?: TemplateFormValues;
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

/**
 * `<select>` hands back `e.target.value` as `string`; these narrow it without
 * an assertion. They read the options array rather than a second list, so
 * there is nothing here that can drift from what is rendered.
 */
function isCancelDeadline(v: string): v is CancelDeadline {
  return CANCEL_DEADLINE_OPTIONS.some((o) => o.value === v);
}

function isAutoCancelCheck(v: string): v is AutoCancelCheck {
  return AUTO_CANCEL_OPTIONS.some((o) => o.value === v);
}

const INITIAL_VALUES: TemplateFormValues = {
  teacherRoomId: '',
  classType: '',
  description: '',
  dayOfWeek: 0,
  startTime: '09:00',
  durationMinutes: 60,
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
  const [created, setCreated] = useState(false);

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
    setForm((prev) => {
      const maxStudents = room
        ? Math.min(prev.maxStudents, room.capacityOverride)
        : prev.maxStudents;
      return {
        ...prev,
        teacherRoomId,
        roomCost: room ? Number(room.rentalRate) : prev.roomCost,
        maxStudents,
        minStudents: Math.min(prev.minStudents, maxStudents),
      };
    });
    setSuccess('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // #40. A settled create must not be re-submittable, including by pressing
    // Enter in a still-mounted field — the button is gone, the form is not.
    if (created) return;
    if (!form.teacherRoomId) {
      setError('Select a room');
      return;
    }
    if (!form.classType.trim()) {
      setError('Class type is required');
      return;
    }
    // Mirrors createClassTemplateSchema's and updateClassTemplateSchema's
    // refines (schemas.ts) so a teacher sees the message immediately instead
    // of after a round trip. This restates rules that live in schemas.ts —
    // the exact defect class this PR exists to remove — and the pins above
    // cannot help: they compare key sets, not predicates, so a refine added
    // or changed there fails no build here. The tests in
    // template-form.test.tsx are the only thing holding this mirror true.
    //
    // The room-cost check is create-only because the underlying refine is:
    // updateClassTemplateSchema has no minRate/roomCost refine, so a PUT
    // carrying an already-subsidizing rate is one the server itself would
    // not reject.
    if (form.minStudents > form.maxStudents) {
      setError('Min students cannot exceed max students');
      return;
    }
    if (form.minRate > form.targetRate) {
      setError('Min rate cannot exceed target rate');
      return;
    }
    if (mode === 'create' && form.minRate < -form.roomCost) {
      setError('Min rate cannot subsidize more than the room cost — prices would go negative');
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

      // The intersection, not either half: one body goes to both endpoints, so
      // it has to satisfy both schemas. The pins above hold the *key sets*
      // against both; this annotation is what holds the *value types* — without
      // it the literal is inferred, and retyping a schema field (say
      // `durationMinutes` to a string) would change what the route expects
      // while this file kept compiling.
      const payload: CreateTemplateWire & UpdateTemplateWire = {
        ...form,
        classType: form.classType.trim(),
        description: form.description.trim() || null,
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to save');
        return;
      }

      if (mode === 'create') {
        // #40. POST /api/class-templates is not idempotent: a second request
        // creates a second template and regenerates a second set of bookable
        // classes. The push below normally unmounts this form; when it does not
        // commit, `created` is what stops a populated, re-enabled form inviting
        // the click that duplicates the teacher's whole schedule.
        setCreated(true);
        router.push('/settings/recurring');
      } else {
        // Say honestly what the edit reached: mutable upcoming instances
        // sync, booked ones keep their settings.
        const json: {
          data?: { sync?: { synced: number; regenerated: number; kept: number } };
        } = await res.json();
        const sync = json.data?.sync;
        const parts: string[] = ['Saved.'];
        if (sync) {
          if (sync.synced > 0) {
            parts.push(`Applied to ${sync.synced} upcoming ${sync.synced === 1 ? 'class' : 'classes'}.`);
          }
          if (sync.regenerated > 0) {
            parts.push(`${sync.regenerated} rescheduled to the new day.`);
          }
          if (sync.kept > 0) {
            parts.push(
              `${sync.kept} ${sync.kept === 1 ? 'class' : 'classes'} with bookings ${sync.kept === 1 ? 'keeps' : 'keep'} current settings.`,
            );
          }
        }
        setSuccess(parts.join(' '));
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
          className="bg-sand-soft border border-border rounded-field px-4 py-3 min-h-24 text-ink text-base focus:outline-none focus:shadow-focus w-full"
        />
      </div>

      <Select
        id="room"
        label="Room"
        value={form.teacherRoomId}
        onChange={(e) => handleRoomChange(e.target.value)}
      >
        <option value="">Select a room</option>
        {teacherRooms.map((tr) => (
          <option key={tr.id} value={tr.id}>
            {formatRoomLocation(tr.room.roomName, tr.room.venueName)}
          </option>
        ))}
      </Select>

      <Select
        id="dayOfWeek"
        label="Day"
        value={form.dayOfWeek}
        onChange={(e) => update('dayOfWeek', Number(e.target.value))}
      >
        {DAY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </Select>

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

      <div className="grid grid-cols-3 gap-3">
        <Input
          label="Room cost"
          type="number"
          step="0.01"
          value={String(form.roomCost)}
          onChange={(e) => update('roomCost', Number(e.target.value))}
        />
        <Input
          label="Min rate"
          type="number"
          step="0.01"
          value={String(form.minRate)}
          onChange={(e) => update('minRate', Number(e.target.value))}
        />
        <Input
          label="Target rate"
          type="number"
          step="0.01"
          value={String(form.targetRate)}
          onChange={(e) => update('targetRate', Number(e.target.value))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Min students"
          type="number"
          value={String(form.minStudents)}
          onChange={(e) => {
            const min = Math.min(Number(e.target.value), form.maxStudents);
            update('minStudents', min);
          }}
        />
        <Input
          label="Max students"
          type="number"
          value={String(form.maxStudents)}
          onChange={(e) => {
            const max = Math.min(Number(e.target.value), roomCapacity);
            setForm((prev) => ({
              ...prev,
              maxStudents: max,
              minStudents: Math.min(prev.minStudents, max),
            }));
            setSuccess('');
          }}
        />
      </div>

      <PricingPreviewTable
        roomCost={form.roomCost}
        minRate={form.minRate}
        targetRate={form.targetRate}
        minStudents={form.minStudents}
        maxStudents={form.maxStudents}
      />

      <Select
        id="cancelDeadline"
        label="Cancellation deadline"
        value={form.cancelDeadline}
        onChange={(e) => {
          if (isCancelDeadline(e.target.value)) update('cancelDeadline', e.target.value);
        }}
      >
        {CANCEL_DEADLINE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </Select>

      <Select
        id="autoCancelCheck"
        label="Auto-cancel check"
        value={form.autoCancelCheck}
        onChange={(e) => {
          if (isAutoCancelCheck(e.target.value)) update('autoCancelCheck', e.target.value);
        }}
      >
        {AUTO_CANCEL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </Select>

      {error && <p className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      {created ? (
        <SettledNotice
          label="Created"
          actionLabel="Go to recurring classes"
          size="sm"
          onAction={() => router.push('/settings/recurring')}
        />
      ) : (
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
      )}
    </form>
  );
}
