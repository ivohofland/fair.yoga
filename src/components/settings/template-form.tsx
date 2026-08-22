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
import {
  resumeMessage,
  templateUpdatedMessage,
} from '@/components/settings/template-action-messages';
import type { TemplateGenerationState } from '@/lib/template-selection';
import { anyBlocked, type SkipCounts } from '@/lib/generation';

interface TeacherRoomOption {
  id: string;
  isArchived: boolean;
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

/**
 * #40 (whole-branch review F8). Where a successful create navigates, written
 * once. The push and the settled notice's retry are the *same* navigation —
 * two literals is how a retry ends up somewhere the create did not go, and the
 * notice's label ("Go to recurring classes") would then be a lie no test
 * comparing one literal to itself could catch.
 */
const RECURRING_LIST_PATH = '/settings/recurring';

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
  // Issue 76. Held separately from `teacherRooms.length` (which is the
  // filtered, offerable count) so the empty state below can tell "no rooms
  // at all" from "rooms exist, all archived" — the filter collapses both to
  // zero without this.
  const [allRoomsCount, setAllRoomsCount] = useState(0);
  const [roomsFailed, setRoomsFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);
  // The filter below keys off this prop rather than `form.teacherRoomId` so
  // the effect only refires when the *seeded* room changes, not on every
  // dropdown change a teacher makes while the form is open — keying off
  // `form` state would refetch on each selection.
  //
  // It does refire on one real path: `handleSubmit`'s edit branch calls
  // `router.refresh()` (below) after a save, which re-renders the server
  // parent (`settings/recurring/[id]/page.tsx`) with a freshly-queried
  // `initial`. If that save changed the room, this value's identity changes
  // and the effect runs again. That is accepted, not a bug to route around:
  // `GET /api/teacher-rooms` is idempotent, `loading` is not reset so there
  // is no flash, and the refetched list is only more current for it.
  const initialTeacherRoomId = initial?.teacherRoomId;

  useEffect(() => {
    async function fetchRooms() {
      try {
        const res = await fetch('/api/teacher-rooms');
        // A failed load is NOT an absence of rooms. Without this the empty
        // list spoke for the failure and the teacher was told to add a room
        // they already own — the exact message `allRoomsCount` exists to stop.
        if (!res.ok) {
          setRoomsFailed(true);
          return;
        }
        const json: { data: TeacherRoomOption[] } = await res.json();
        setAllRoomsCount(json.data.length);
        // Issue 76: an archived room accepts no new commitments, so it is not
        // offered here. FEEDBACK, NOT ENFORCEMENT — `POST /api/class-templates`
        // refuses an archived room regardless, and must keep doing so.
        //
        // The current selection survives the filter: in `edit` mode this form
        // may be editing a paused template that already sits on an archived
        // room, and dropping its option would silently blank the field.
        setTeacherRooms(
          json.data.filter((tr) => !tr.isArchived || tr.id === initialTeacherRoomId),
        );
      } catch {
        // There was no `catch` here at all, so a thrown `fetch` escaped
        // `void fetchRooms()` as an unhandled rejection and still rendered
        // "No rooms configured."
        setRoomsFailed(true);
      } finally {
        setLoading(false);
      }
    }
    void fetchRooms();
  }, [initialTeacherRoomId]);

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
    // #40, corrected by whole-branch review F4. Defence-in-depth against a
    // future shape of this form, not a path the UI can take today. The claim
    // this comment used to make — that Enter in a still-mounted field would
    // re-submit — is not what HTML does: implicit submission needs either a
    // submit button (settlement removes the only one; `SettledNotice`'s
    // control is `type="button"`) or exactly one field that blocks it, and
    // this form has eight. That is precisely why no test could pin the guard,
    // and why a synthetic `fireEvent.submit` pins it instead: the day someone
    // re-adds a submit button outside the settled branch, or this form is
    // reduced to a single field, the guard is the second line and the test is
    // what proves it can still fail.
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
        // #40. A second identical POST to /api/class-templates now collides
        // with `ClassTemplate_teacher_slot_unique` ((teacherId, dayOfWeek,
        // startTime) WHERE isArchived = false, #196) and comes back as a 409
        // DUPLICATE_TEMPLATE_SLOT (`api/class-templates/route.ts`) rather
        // than a second template. That backstop is server-side and after the
        // round trip, though — it does not stop the second request from
        // being sent, or turn its failure into anything gentler than an
        // error banner. The push below normally unmounts this form; when it
        // does not commit, `created` is what stops a populated, re-enabled
        // form from inviting the click that resends the same create and now
        // earns a 409 instead of duplicating the teacher's whole schedule.
        //
        // The POST also returns `added` and `counts` — the same shape the PATCH
        // `active` arm carries (#296 nested them). #196 made
        // `slotTaken` reachable here for the first time: a teacher creating a
        // recurring class onto a day/time they already occupy gets a live
        // template whose window came back short. A clean window navigates
        // straight to the list as before; a short one stays on this page and
        // says so, via the same `resumeMessage` the resume button renders —
        // `scheduled` is exactly `added` here, since nothing existed under
        // this brand-new template before this create.
        //
        // `alreadyThisWeek` rides along inside `counts` — it is not a field of
        // this payload in its own right (#296) — and the GATE below
        // deliberately does not test it. On create that count is structurally
        // 0: `already_this_week` requires a class of THIS template already
        // holding the week, and the template was created moments earlier in
        // the same transaction with no `Class` rows of its own — the generator
        // reads them by `templateId`, and there are none. A gate term that can
        // never fire would tell the next reader that create can produce this
        // reason, which it cannot.
        //
        // Read from the wire rather than hard-coded to 0 all the same: the
        // POST route already sends it, and a literal would be a claim where
        // this is a measurement. If create ever CAN produce the reason, this
        // gate must gain the term in the same change — otherwise the window
        // comes back short and the page navigates away without saying so.
        // `counts` is optional in this parse shape even though the route always
        // sends it — see `studio-template-form.tsx`'s twin for why nesting makes
        // that distinction load-bearing rather than pedantic.
        const json: { data?: { added: number; counts?: SkipCounts } } = await res.json();
        const result = json.data;
        setCreated(true);
        // `anyBlocked` rather than a hand-listed pair (`@/lib/generation`). This
        // gate enumerated its terms until #296 added `blockedByOtherFamily` —
        // the first such reason THE GATE DID NOT ALREADY LIST (`slotTaken` has
        // been reachable on create since #196, and the gate listed it) — and
        // then navigated away from a short window in silence. See that
        // function's docblock; the paragraph ABOVE is the rule it broke.
        if (result?.counts && anyBlocked(result.counts)) {
          setSuccess(resumeMessage(result.added, result.added, result.counts));
        } else {
          router.push(RECURRING_LIST_PATH);
        }
      } else {
        // Nothing to count: since #194 an edit changes the template row and
        // no generated class, so there is no arrival, delete or kept tally to
        // report. What there IS to say is WHEN — the service probes for the
        // first week the new schedule reaches and sends its Monday back as
        // `firstEffective`, an ISO string on the wire.
        //
        // `?? null` rather than a bare read, and the type says `string | null`
        // rather than `string`: `null` is what the service sends when no free
        // week is inside its horizon, `undefined` is what a server predating
        // this field sends, and `templateUpdatedMessage` answers both by
        // dropping the clause. Neither may become `new Date(undefined)`, which
        // renders "Invalid Date" into the middle of the sentence.
        //
        // `generationState` is the other half of the same sentence and cannot
        // be inferred from `firstEffective`: `null` means "no free week in
        // view" for a live template and "the sweep will never run" for a
        // paused or archived one, and only the service can tell them apart
        // (`@/lib/template-selection`). Re-deriving it here from the
        // `isActive`/`isArchived` columns this body also carries would put a
        // fourth copy of the generator's eligibility gate in the copy layer.
        //
        // Narrowed by comparison rather than cast. This is wire data: a server
        // predating the field sends nothing, and anything unrecognised must
        // land on `'active'`, which is the pre-#194 sentence and the only one
        // safe to say about a template whose state we do not know. A cast
        // would hand an unknown string to an exhaustive `switch` that throws
        // on it — an unhandled error where a teacher expects a confirmation.
        const json: {
          data?: { firstEffective?: string | null; generationState?: string };
        } = await res.json();
        const firstEffective = json.data?.firstEffective ?? null;
        const wireState = json.data?.generationState;
        const generationState: TemplateGenerationState =
          wireState === 'paused' || wireState === 'archived' ? wireState : 'active';
        setSuccess(
          templateUpdatedMessage(firstEffective ? new Date(firstEffective) : null, generationState),
        );
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

  if (roomsFailed) {
    return (
      <div className="py-12 text-center">
        <p className="text-brown mb-4">Couldn&apos;t load your rooms.</p>
        <p className="text-sm text-brown">Check your connection and reload the page.</p>
      </div>
    );
  }

  if (teacherRooms.length === 0) {
    // Issue 76: a teacher whose rooms are all archived still has `allRoomsCount
    // > 0` — the filter above is what emptied `teacherRooms`, not an absence of
    // rooms. Telling them to add a room they already own would be wrong; the
    // way out is un-archiving one.
    if (allRoomsCount > 0) {
      return (
        <div className="py-12 text-center">
          <p className="text-brown mb-4">All your rooms are archived.</p>
          <p className="text-sm text-brown">Unarchive one in Settings to schedule here.</p>
        </div>
      );
    }
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
          onAction={() => router.push(RECURRING_LIST_PATH)}
        />
      ) : (
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
      )}
    </form>
  );
}
