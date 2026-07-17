'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import { PricingPreviewTable } from '@/components/class/pricing-preview-table';
import { formatRoomLocation } from '@/lib/format';

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

type StepErrors = Record<string, string>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CreateClassPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [errors, setErrors] = useState<StepErrors>({});
  const [teacherRooms, setTeacherRooms] = useState<TeacherRoomData[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Fetch teacher rooms on mount
  useEffect(() => {
    async function fetchRooms() {
      try {
        const res = await fetch('/api/teacher-rooms');
        if (!res.ok) {
          setLoading(false);
          return;
        }
        const json: { data: TeacherRoomData[] } = await res.json();
        setTeacherRooms(json.data);
      } catch {
        // Silently fail — empty room list will show message
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
    setSubmitting(true);
    setSubmitError('');

    try {
      const res = await fetch('/api/classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teacherRoomId: form.teacherRoomId,
          classType: form.classType,
          date: form.date,
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
        setSubmitError(json.error?.message ?? 'Failed to create class');
        return;
      }

      const json: { data: { id: string } } = await res.json();
      router.push(`/class/${json.data.id}`);
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

  if (teacherRooms.length === 0) {
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
              {form.date} at {form.startTime} &middot; {form.durationMinutes} min
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
        {step > 1 ? (
          <Button variant="secondary" onClick={handleBack} type="button">
            Back
          </Button>
        ) : (
          <div />
        )}

        {step < 4 ? (
          <Button onClick={handleNext} type="button">
            Next
          </Button>
        ) : (
          <Button onClick={handleSubmit} disabled={submitting} type="button">
            {submitting ? 'Creating...' : 'Create class'}
          </Button>
        )}
      </div>
    </>
  );
}
