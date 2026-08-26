'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { createClassSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import { SettledNotice } from '@/components/ui/settled-notice';
import { PricingPreviewTable } from '@/components/class/pricing-preview-table';
import { formatRoomLocation, formatDateWithYear } from '@/lib/format';
import { useTodayLocal } from '@/lib/use-today-local';
import { CANCEL_DEADLINE_OPTIONS, AUTO_CANCEL_OPTIONS } from '@/lib/class-options';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoomData {
  id: string;
  roomName: string;
  venueName: string;
}

interface TeacherRoomData {
  id: string;
  roomId: string;
  isArchived: boolean;
  capacityOverride: number;
  rentalRate: number | string;
  room: RoomData;
}

interface FormData {
  // Step 1: Basics
  teacherRoomId: string;
  classType: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  // Step 2: Pricing
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  // Step 3: Policies
  cancelDeadline: string;
  autoCancelCheck: string;
}

type CreateClassWire = z.infer<typeof createClassSchema>;

/**
 * #136. `FormData` is the list; the body is `form` itself, so the two cannot
 * drift. These pins tie that list to the schema.
 *
 * One key is excluded from the forward pin. `description` — `createClassSchema`
 * accepts it and `POST /api/classes` writes it, but this wizard renders no
 * input for it, so a teacher can only describe a class by editing it
 * afterwards. That is a real gap, filed as #147, not something to paper over by
 * adding a field inside an unrelated change.
 *
 * `templateId` used to be excluded here too. It is gone from the schema as of
 * #146 — it was server-set, reached `prisma.class.create` from the request body
 * with no ownership check, and appeared in no UI.
 *
 * What this pin enforces, exactly: every key `createClassSchema` declares
 * except `description` is a key of `FormData`, this form's own value type. Not
 * that the field is *rendered* — `FormData` is a TypeScript interface, and
 * adding a key to it with no matching input keeps both pins green. What catches
 * that is `page.test.tsx`, which drives the rendered inputs and asserts the
 * whole POST body.
 */
type ClassFormExclusion = 'description';

/**
 * The exclusion's own pin. Without it the exclusion is unfalsifiable in the
 * direction that matters: measured — removing `description` from
 * `createClassSchema` produces no error here, the exclusion silently becomes a
 * no-op, and it then survives forever looking like protection while protecting
 * nothing. When #147 is fixed by adding a description input, this is what fails
 * and tells whoever adds it to delete the exclusion. Same rot the pins in
 * `class-lifecycle.ts` guard against one file over.
 */
const _exclusionsAreRealKeys: NoneOf<Exclude<ClassFormExclusion, keyof CreateClassWire>> = true;
const _formCoversCreate: NoneOf<
  Exclude<Exclude<keyof CreateClassWire, ClassFormExclusion>, keyof FormData>
> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof FormData, keyof CreateClassWire>> = true;
void _exclusionsAreRealKeys;
void _formCoversCreate;
void _formHasNoExtras;

type StepErrors = Record<string, string>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_FORM: FormData = {
  teacherRoomId: '',
  classType: '',
  date: '',
  startTime: '',
  durationMinutes: 60,
  roomCost: 0,
  minRate: 15,
  targetRate: 25,
  minStudents: 4,
  maxStudents: 12,
  cancelDeadline: 'HOURS_24',
  autoCancelCheck: 'HOURS_2',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDeadlineLabel(value: string): string {
  return CANCEL_DEADLINE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function formatAutoCancelLabel(value: string): string {
  return AUTO_CANCEL_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/**
 * #40 (whole-branch review F1/F8). Where a successful create navigates,
 * written once. The push and the settled notice's retry are the *same*
 * navigation, and two literals is how a retry ends up somewhere the create did
 * not go — with the notice's label promising otherwise.
 */
function classPath(id: string): string {
  return `/class/${id}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CreateClassPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [errors, setErrors] = useState<StepErrors>({});
  const [teacherRooms, setTeacherRooms] = useState<TeacherRoomData[]>([]);
  // Issue 76. Kept separately from `teacherRooms.length` (the filtered,
  // offerable count) so the empty state below can tell "no rooms at all"
  // from "rooms exist, all archived" — the filter collapses both to zero.
  const [allRoomsCount, setAllRoomsCount] = useState(0);
  const [roomsFailed, setRoomsFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  // Client-only, so `undefined` for the server render and the hydration pass.
  const minDate = useTodayLocal();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  /**
   * #40. The settled flag, holding the created class's id rather than a bare
   * `true` as the two template forms do: this wizard's destination is the new
   * class's own page, so the id has to be kept anyway, and a boolean beside it
   * would be a second piece of state saying the same thing with room to
   * disagree.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Fetch teacher rooms on mount
  useEffect(() => {
    async function fetchRooms() {
      try {
        const res = await fetch('/api/teacher-rooms');
        if (!res.ok) {
          // A failed load is NOT an absence of rooms — see the render branch.
          setRoomsFailed(true);
          setLoading(false);
          return;
        }
        const json: { data: TeacherRoomData[] } = await res.json();
        setAllRoomsCount(json.data.length);
        // Issue 76: archived rooms are not offered for new classes. Feedback
        // only — a class created here is born `draft`, and door 2
        // (`transitionClass`) is what actually refuses publishing into an
        // archived room.
        setTeacherRooms(json.data.filter((tr) => !tr.isArchived));
      } catch {
        setRoomsFailed(true);
      } finally {
        setLoading(false);
      }
    }
    void fetchRooms();
  }, []);

  // Derive selected room data
  const selectedRoom = teacherRooms.find((tr) => tr.id === form.teacherRoomId);
  const roomCapacity = selectedRoom?.capacityOverride ?? 30;

  // -------------------------------------------------------------------------
  // Field update helpers
  // -------------------------------------------------------------------------

  function updateField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
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
    setErrors((prev) => {
      const next = { ...prev };
      delete next.teacherRoomId;
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  function validateStep(s: number): boolean {
    const errs: StepErrors = {};

    if (s === 1) {
      if (!form.teacherRoomId) errs.teacherRoomId = 'Select a room';
      if (!form.classType.trim()) errs.classType = 'Enter a class type';
      if (!form.date) errs.date = 'Select a date';
      if (!form.startTime) errs.startTime = 'Enter a start time';
      if (form.durationMinutes <= 0) errs.durationMinutes = 'Duration must be positive';
    }

    if (s === 2) {
      if (form.roomCost < 0) errs.roomCost = 'Room cost cannot be negative';
      if (form.minStudents <= 0) errs.minStudents = 'Min students must be at least 1';
      if (form.maxStudents <= 0) errs.maxStudents = 'Max students must be at least 1';
      if (form.maxStudents < form.minStudents)
        errs.maxStudents = 'Max must be >= min students';
      if (form.maxStudents > roomCapacity)
        errs.maxStudents = `Cannot exceed room capacity (${roomCapacity})`;
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  function handleNext() {
    if (validateStep(step)) {
      setStep((s) => s + 1);
    }
  }

  function handleBack() {
    setStep((s) => s - 1);
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  async function handleSubmit() {
    // #40 (whole-branch review F1/F4). No `if (createdId) return;` twin of the
    // two template forms here, deliberately. This wizard has no `<form>`, and
    // this function's only caller is the step-4 button that settling replaces,
    // so such a guard would have no reachable entry point — not even the
    // synthetic `fireEvent.submit` that pins the template forms' — and this
    // branch does not ship guards that cannot fail. Wrap these steps in a
    // `<form>`, or give this function a second caller, and the guard becomes
    // both necessary and pinnable: add it then, as `studio-class/new` has it.
    setSubmitting(true);
    setSubmitError('');

    try {
      const res = await fetch('/api/classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setSubmitError(json.error?.message ?? 'Failed to create class');
        return;
      }

      const json: { data: { id: string } } = await res.json();
      // #40. A second identical POST to /api/classes now collides with
      // `CalendarEntry_teacher_slot_excl` (teacherId WITH =, span WITH &&,
      // WHERE cancelledAt IS NULL — #327) and comes back as a 409
      // DUPLICATE_CLASS_SLOT (`api/classes/route.ts`) rather than a second
      // row. That backstop is server-side and after the round trip, though —
      // it does not stop the second request from being sent, or turn its
      // failure into anything gentler than an error banner. The push below
      // normally unmounts this wizard; when it does not commit, `createdId`
      // is what stops a populated review step with "Create class" re-enabled
      // from inviting the click that resends the same create and now earns a
      // 409 instead of a silent duplicate.
      setCreatedId(json.data.id);
      router.push(classPath(json.data.id));
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="py-12 text-center type-caption">Loading rooms...</div>
    );
  }

  if (roomsFailed) {
    // Distinct from both empty states below. On a 401/500/network failure
    // `allRoomsCount` stays 0, so the teacher was told "No rooms configured —
    // add a room in Settings" while their rooms existed and the fetch simply
    // failed. That is the message this branch's `allRoomsCount` work exists to
    // prevent, reached down the path nobody looked at.
    return (
      <EmptyState
        title="Couldn't load your rooms"
        body="Check your connection and reload the page."
      />
    );
  }

  if (teacherRooms.length === 0) {
    // Issue 76: a teacher whose rooms are all archived still has
    // `allRoomsCount > 0` — the filter above is what emptied `teacherRooms`,
    // not an absence of rooms. Telling them to add a room they already own
    // would be wrong; the way out is un-archiving one.
    if (allRoomsCount > 0) {
      return (
        <EmptyState
          title="All your rooms are archived"
          body="Unarchive one in Settings to schedule here."
        />
      );
    }
    return (
      <EmptyState
        title="No rooms configured"
        body="Add a room in Settings before creating a class."
      />
    );
  }

  return (
    <>
      {/* Header */}
      <div className="mb-6">
        <button
          type="button"
          onClick={() => router.push('/')}
          className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
        >
          <Icon name="arrow-left" size={18} />
          Schedule
        </button>
        <h1 className="type-display">New class</h1>
        <p className="type-caption mt-1">Step {step} of 4</p>
        <button
          type="button"
          onClick={() => router.push('/studio-class/new')}
          className="type-caption mt-2 inline-block"
        >
          Or log a studio class
        </button>
      </div>

      {/* Step 1: Basics */}
      {step === 1 && (
        <div className="flex flex-col gap-4">
          <Select
            id="room"
            label="Room"
            value={form.teacherRoomId}
            onChange={(e) => handleRoomChange(e.target.value)}
            error={errors.teacherRoomId}
          >
            <option value="">Select a room</option>
            {teacherRooms.map((tr) => (
              <option key={tr.id} value={tr.id}>
                {formatRoomLocation(tr.room.roomName, tr.room.venueName)}
              </option>
            ))}
          </Select>

          <Input
            id="classType"
            label="Class type"
            placeholder="e.g. Vinyasa, Hatha, Yin"
            value={form.classType}
            onChange={(e) => updateField('classType', e.target.value)}
            error={errors.classType}
          />

          <Input
            id="date"
            label="Date"
            type="date"
            // A hint only, and unlike the edit form there is no service guard
            // behind it (#249, spec §6): a past-dated class is created `draft`,
            // which no sweep selects and no registration can attach to. What is
            // guarded is publishing it.
            //
            // Through the hook for the same reason the edit form uses it, even
            // though THIS page would survive without it and it is worth saying
            // why the belt is worn anyway. The `if (loading)` early return
            // above means the server render of this wizard is the string
            // "Loading rooms..." — the date field does not exist in it, so no
            // server-computed bound has ever reached a browser here. That is an
            // accident of an unrelated fetch gate, not a property of this
            // field: delete the gate, or server-render the room list, and the
            // UTC bound arrives silently. The hook makes the guarantee local to
            // the control that needs it.
            min={minDate}
            value={form.date}
            onChange={(e) => updateField('date', e.target.value)}
            error={errors.date}
          />

          <Input
            id="startTime"
            label="Start time"
            type="time"
            value={form.startTime}
            onChange={(e) => updateField('startTime', e.target.value)}
            error={errors.startTime}
          />

          <Input
            id="durationMinutes"
            label="Duration (minutes)"
            type="number"
            value={String(form.durationMinutes)}
            onChange={(e) => updateField('durationMinutes', Number(e.target.value))}
            error={errors.durationMinutes}
          />
        </div>
      )}

      {/* Step 2: Pricing */}
      {step === 2 && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <Input
              id="roomCost"
              label="Room cost"
              type="number"
              step="0.01"
              value={String(form.roomCost)}
              onChange={(e) => updateField('roomCost', Number(e.target.value))}
              error={errors.roomCost}
            />
            <Input
              id="minRate"
              label="Min rate"
              type="number"
              step="0.01"
              value={String(form.minRate)}
              onChange={(e) => updateField('minRate', Number(e.target.value))}
              error={errors.minRate}
            />
            <Input
              id="targetRate"
              label="Target rate"
              type="number"
              step="0.01"
              value={String(form.targetRate)}
              onChange={(e) => updateField('targetRate', Number(e.target.value))}
              error={errors.targetRate}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              id="minStudents"
              label="Min students"
              type="number"
              value={String(form.minStudents)}
              onChange={(e) => {
                const min = Math.min(Number(e.target.value), form.maxStudents);
                updateField('minStudents', min);
              }}
              error={errors.minStudents}
            />
            <Input
              id="maxStudents"
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
                setErrors((prev) => {
                  const next = { ...prev };
                  delete next.maxStudents;
                  delete next.minStudents;
                  return next;
                });
              }}
              error={errors.maxStudents}
            />
          </div>

          <PricingPreviewTable
            roomCost={form.roomCost}
            minRate={form.minRate}
            targetRate={form.targetRate}
            minStudents={form.minStudents}
            maxStudents={form.maxStudents}
          />
        </div>
      )}

      {/* Step 3: Policies */}
      {step === 3 && (
        <div className="flex flex-col gap-4">
          <Select
            id="cancelDeadline"
            label="Cancellation deadline"
            value={form.cancelDeadline}
            onChange={(e) => updateField('cancelDeadline', e.target.value)}
          >
            {CANCEL_DEADLINE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>

          <Select
            id="autoCancelCheck"
            label="Auto-cancel check"
            value={form.autoCancelCheck}
            onChange={(e) => updateField('autoCancelCheck', e.target.value)}
          >
            {AUTO_CANCEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* Step 4: Confirm */}
      {step === 4 && (
        <div className="flex flex-col gap-3">
          <h2 className="type-subtitle mb-2">
            Review your class
          </h2>

          <div className="py-2 border-b border-border">
            <span className="type-label">Room</span>
            <p className="text-base text-ink">
              {selectedRoom
                ? formatRoomLocation(selectedRoom.room.roomName, selectedRoom.room.venueName)
                : '-'}
            </p>
          </div>

          <div className="py-2 border-b border-border">
            <span className="type-label">Class type</span>
            <p className="text-base text-ink">{form.classType}</p>
          </div>

          <div className="py-2 border-b border-border">
            <span className="type-label">Date &amp; time</span>
            <p className="text-base text-ink">
              {/* `form.date` is a date-only ISO string ("2026-06-12") from the
                  <input type="date">; `new Date(...)` on that shape parses as
                  UTC midnight, which is what formatDateWithYear's UTC
                  accessors expect. Step 1's validateStep gates `date` as
                  required before this step is reachable, so it is never ''
                  here. */}
              {formatDateWithYear(new Date(form.date))} at {form.startTime} &middot; {form.durationMinutes} min
            </p>
          </div>

          <div className="py-2 border-b border-border">
            <span className="type-label">Pricing</span>
            <p className="text-base text-ink">
              Room cost: &euro;{form.roomCost.toFixed(2)} &middot; Rate: &euro;
              {form.minRate.toFixed(2)} &ndash; &euro;{form.targetRate.toFixed(2)}
            </p>
          </div>

          <div className="py-2 border-b border-border">
            <span className="type-label">Students</span>
            <p className="text-base text-ink">
              {form.minStudents} &ndash; {form.maxStudents}
            </p>
          </div>

          <div className="py-2 border-b border-border">
            <span className="type-label">Cancellation deadline</span>
            <p className="text-base text-ink">{formatDeadlineLabel(form.cancelDeadline)}</p>
          </div>

          <div className="py-2 border-b border-border">
            <span className="type-label">Auto-cancel check</span>
            <p className="text-base text-ink">{formatAutoCancelLabel(form.autoCancelCheck)}</p>
          </div>

          {submitError && (
            <p className="text-sm text-danger mt-2">{submitError}</p>
          )}
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex justify-between mt-8">
        {/*
          #40, PR #198 review P2. The settled state replaced the submit control
          and left the wizard's *other* exit alone, so Back stayed live in two
          states it must not be.

          Gated on `!createdId`: steps 1–3 remain mounted state — populated,
          valid and editable — so after a create whose push was dropped, Back
          led into the form for a class that already exists. Edit anything,
          page forward, and step 4 shows the same "Created" notice pointing at
          the original class. Every edit in that detour is discarded in
          silence, and nothing on screen says so. (Not a duplicate-create path:
          `createdId` has already replaced the submit button, so `handleSubmit`
          stays unreachable. The harm is lost edits, which is quieter.)

          Disabled while `submitting`, because the settled notice and
          `submitError` both render inside `{step === 4 && …}` — stepping off
          4 mid-flight throws the outcome away, success and failure alike, and
          shows step 3 as though nothing had been submitted.

          Gated here rather than inside `handleBack`: this button is that
          function's only caller, so a guard in there could not be reached by
          any test, and this branch does not ship guards that cannot fail —
          same reasoning as `handleSubmit` above.
        */}
        {step > 1 && !createdId ? (
          <Button variant="secondary" onClick={handleBack} type="button" disabled={submitting}>
            Back
          </Button>
        ) : (
          <div />
        )}

        {step < 4 ? (
          <Button onClick={handleNext} type="button">
            Next
          </Button>
        ) : createdId ? (
          <SettledNotice
            label="Created"
            actionLabel="Go to the class"
            size="sm"
            onAction={() => router.push(classPath(createdId))}
          />
        ) : (
          <Button onClick={handleSubmit} disabled={submitting} type="button">
            {submitting ? 'Creating...' : 'Create class'}
          </Button>
        )}
      </div>
    </>
  );
}
