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
    if (form.minStudents > form.maxStudents) {
      setError('Min students cannot exceed max students');
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
          onChange={(e) => update('minStudents', Number(e.target.value))}
        />
        <Input
          label="Max students"
          type="number"
          value={String(form.maxStudents)}
          onChange={(e) => update('maxStudents', Math.min(Number(e.target.value), roomCapacity))}
        />
      </div>

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
