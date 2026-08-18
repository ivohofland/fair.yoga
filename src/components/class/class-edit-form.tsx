'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updateClassSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { ECONOMIC_FIELDS } from '@/lib/class-fields';
import { useTodayLocal } from '@/lib/use-today-local';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PricingPreviewTable } from '@/components/class/pricing-preview-table';

export interface ClassEditInitial {
  classType: string;
  description: string;
  date: string; // YYYY-MM-DD
  startTime: string;
  durationMinutes: number;
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
}

type UpdateClassWire = z.infer<typeof updateClassSchema>;

/**
 * #81. `ClassEditInitial` is the only enumeration of this form's fields, and
 * these two pins are what make it safe to have only one. Before them the list
 * was stated twice and checked nowhere, under a comment asserting it "mirrors
 * updateClassSchema exactly".
 *
 * Forward: a field added to the schema with no form field fails the build,
 * naming it — the defect #81 reports, where a teacher-editable field looks
 * shipped with no input rendered.
 *
 * Reverse: a field the schema dropped but the form still sends. `.strict()`
 * would 400 it at runtime; this catches it at compile time instead.
 *
 * `NoneOf` resolves to `T` rather than collapsing to `never`, so a failure
 * reads `Type 'true' is not assignable to type '"waitlistCap"'` instead of
 * naming no field at all.
 */
const _formCoversSchema: NoneOf<Exclude<keyof UpdateClassWire, keyof ClassEditInitial>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof ClassEditInitial, keyof UpdateClassWire>> = true;
void _formCoversSchema;
void _formHasNoExtras;

interface ClassEditFormProps {
  classId: string;
  settingsLocked: boolean;
  initial: ClassEditInitial;
}

// Details always editable, the five economic fields only while unlocked.
// Policies aren't part of the update schema, so they aren't part of this form.
export function ClassEditForm({ classId, settingsLocked, initial }: ClassEditFormProps) {
  const router = useRouter();
  // Client-only, so `undefined` for the server render and the hydration pass.
  const minDate = useTodayLocal();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  function set<K extends keyof ClassEditInitial>(key: K, value: ClassEditInitial[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    // Mirrors two of updateClassSchema's refines (schemas.ts) so a teacher
    // sees the message immediately instead of after a round trip. This
    // restates rules that live in schemas.ts — the exact defect class this
    // PR exists to remove — and the pins above cannot help: they compare key
    // sets, not predicates, so a refine added or changed there fails no
    // build here. The tests in class-edit-form.test.tsx are the only thing
    // holding this mirror true.
    //
    // Only checked while unlocked: locked economics are stripped from the
    // payload below and so are never sent for the schema to validate either,
    // whatever their stored values are.
    if (!settingsLocked) {
      if (form.minStudents > form.maxStudents) {
        setError('Min students cannot exceed max students');
        return;
      }
      if (form.minRate > form.targetRate) {
        setError('Min rate cannot exceed target rate');
        return;
      }
    }

    setSaving(true);
    setSaved(false);
    setError('');
    try {
      // Derived from `form`, not restated. The old builder listed all ten
      // fields a second time; keeping one list is the point of #81, and the
      // pins above are what keep that list honest.
      //
      // Spreading cannot flag an extra field — TypeScript's excess-property
      // check does not survive a spread, which `ClassUpdateData`'s docblock
      // (`class-lifecycle.ts`) records for the route's own payload. The
      // reverse pin covers that instead, but only against
      // `ClassEditInitial`'s statically declared keys — it can't
      // see an own-enumerable property `form` happens to carry at runtime that
      // isn't declared on the type.
      const payload: UpdateClassWire = { ...form, description: form.description || null };
      if (settingsLocked) {
        for (const f of ECONOMIC_FIELDS) delete payload[f];
      }
      const res = await fetch(`/api/classes/${classId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      } else {
        const json = (await res.json()) as { error?: { message?: string } | string };
        const message = typeof json.error === 'string' ? json.error : json.error?.message;
        setError(message ?? 'Could not save the class. Try again.');
        // Refresh on refusal too, not only on success. A 409 here means the
        // server knows something this page does not — the class went terminal
        // while the form was open (the auto-complete sweep, or a cancel in
        // another tab), which is the only way #247's freeze is reachable at
        // all, since the edit page redirects any class that is not
        // draft/open. Without this the teacher is left holding an editable
        // form for a class that can never be edited, and every subsequent
        // Save fails identically. Let the server refuse, then re-read.
        router.refresh();
      }
    } catch (err) {
      // Bound and logged rather than swallowed. This block covers
      // `res.json()` as well as `fetch`, so an Nginx HTML error page, a
      // truncated body or a 502 with no JSON all land here — "Network error"
      // is wrong advice for most of them, and without the log nothing records
      // which one happened.
      console.error('class edit save failed', err);
      setError('Could not reach the server, or it sent something unreadable. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-[480px]">
      <section className="flex flex-col gap-4">
        <Input
          label="Class type"
          value={form.classType}
          onChange={(e) => set('classType', e.target.value)}
        />
        <Textarea
          label="Description"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          rows={3}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Date"
            type="date"
            // A hint, not a guard (#249). `updateClass` refuses a past start
            // independently and answers 409; #247 is the standing reminder
            // that a page-level control is not a service guard.
            //
            // Through the hook rather than calling `todayLocal()` here, and
            // that indirection is the whole point: this form is server-rendered
            // before it is hydrated, and the server's zone is the container's —
            // UTC — not the teacher's. `useTodayLocal` withholds the bound
            // until the browser can supply it. Its docblock has the
            // measurement.
            min={minDate}
            value={form.date}
            onChange={(e) => set('date', e.target.value)}
          />
          <Input
            label="Start time"
            type="time"
            value={form.startTime}
            onChange={(e) => set('startTime', e.target.value)}
          />
        </div>
        <div className="max-w-[200px]">
          <Input
            label="Duration (minutes)"
            type="number"
            value={String(form.durationMinutes)}
            onChange={(e) => set('durationMinutes', Number(e.target.value))}
          />
        </div>
      </section>

      <section>
        <h2 className="type-subtitle mb-1">Economics</h2>
        {settingsLocked && (
          <p className="type-caption mb-3 max-w-[420px]">
            Locked since the first registration — the economics can&apos;t
            change under students.
          </p>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Room cost (€)"
            type="number"
            value={String(form.roomCost)}
            disabled={settingsLocked}
            onChange={(e) => set('roomCost', Number(e.target.value))}
          />
          <Input
            label="Min rate (€)"
            type="number"
            value={String(form.minRate)}
            disabled={settingsLocked}
            onChange={(e) => set('minRate', Number(e.target.value))}
          />
          <Input
            label="Target rate (€)"
            type="number"
            value={String(form.targetRate)}
            disabled={settingsLocked}
            onChange={(e) => set('targetRate', Number(e.target.value))}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3 max-w-[320px]">
          <Input
            label="Min students"
            type="number"
            value={String(form.minStudents)}
            disabled={settingsLocked}
            onChange={(e) => set('minStudents', Number(e.target.value))}
          />
          <Input
            label="Max students"
            type="number"
            value={String(form.maxStudents)}
            disabled={settingsLocked}
            onChange={(e) => set('maxStudents', Number(e.target.value))}
          />
        </div>
        <div className="mt-4">
          <PricingPreviewTable
            roomCost={form.roomCost}
            minRate={form.minRate}
            targetRate={form.targetRate}
            minStudents={form.minStudents}
            maxStudents={form.maxStudents}
          />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save changes'}
        </Button>
        {saved && <span className="type-caption text-teal">Saved</span>}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
