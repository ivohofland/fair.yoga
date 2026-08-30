'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updateStudioClassSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTodayLocal } from '@/lib/use-today-local';
import { readErrorMessage } from '@/lib/client-errors';
import { STUDIO_CLASS_EDIT_REFUSALS } from '@/services/studio-class-edit-refusals';

export interface StudioClassEditInitial {
  classType: string;
  location: string;
  date: string; // YYYY-MM-DD
  startTime: string;
  durationMinutes: number;
  hourlyRate: number;
}

type UpdateStudioClassWire = z.infer<typeof updateStudioClassSchema>;

/**
 * Wire fields this form deliberately does not own: `StudentCountEditor` and
 * `CancelStudioClassButton` write them from the detail page, each with its own
 * gate. Naming them is what lets the forward pin below stay exhaustive without
 * claiming this form should render them.
 */
type OwnedElsewhere = 'studentCount' | 'cancelledAt';

/**
 * #81's pins, which this form needs for the reason #276 exists: `classType`
 * sat in `updateStudioClassSchema` with no input rendered, and nothing said
 * so. The prose that stood here instead ("the five always-writable fields")
 * was a count, which CLAUDE.md forbids precisely because it cannot notice a
 * sixth.
 *
 * Forward: a field added to the schema with no form field — and not claimed by
 * `OwnedElsewhere` — fails the build, naming it. That is #276, caught.
 * Reverse: a field the schema dropped but the form still sends. `.strict()`
 * would 400 it at runtime; this catches it at compile time.
 *
 * `NoneOf` resolves to `T` rather than `never`, so a failure reads
 * `Type 'true' is not assignable to type '"notes"'` and names the offender.
 */
const _formCoversSchema: NoneOf<
  Exclude<keyof UpdateStudioClassWire, keyof StudioClassEditInitial | OwnedElsewhere>
> = true;
const _formHasNoExtras: NoneOf<
  Exclude<keyof StudioClassEditInitial, keyof UpdateStudioClassWire>
> = true;
void _formCoversSchema;
void _formHasNoExtras;

/**
 * The two numeric fields are held as STRINGS and coerced once, at submit.
 *
 * `<input type="number">` reports `''` for anything that is not a valid
 * floating-point number — an emptied field, and every intermediate state of
 * typing `45.` on a `step="0.01"` field. Coercing per keystroke turns each of
 * those into `Number('') === 0`, and `hourlyRate` is
 * `z.number().nonnegative()`, so 0 is ACCEPTED: the rate silently becomes €0,
 * the form says "Saved", and reporting counts the class as zero income.
 * `durationMinutes` is `.positive()` and merely rejects, loudly and in Zod's
 * own words.
 *
 * The create screen for this same entity (`studio-class/new/page.tsx`),
 * `StudentCountEditor` and `EditRoomForm` all hold strings and coerce at send.
 * This is that pattern, not a new one.
 */
type FormState = Record<keyof StudioClassEditInitial, string>;

type FieldErrors = Partial<FormState>;

interface StudioClassEditFormProps {
  studioClassId: string;
  dateEditable: boolean;
  initial: StudioClassEditInitial;
}

function toFormState(initial: StudioClassEditInitial): FormState {
  return {
    classType: initial.classType,
    location: initial.location,
    date: initial.date,
    startTime: initial.startTime,
    durationMinutes: String(initial.durationMinutes),
    hourlyRate: String(initial.hourlyRate),
  };
}

/**
 * Product prose per field, checked before the round trip (#197). Without it the
 * teacher reads `durationMinutes: Too small: expected number to be >0` — a
 * camelCase field name and a Zod internal, rendered verbatim because
 * `(teacher)` pages print `error.message` as-is. The same standard the 409
 * refusals in this file already meet.
 */
function validate(form: FormState, dateEditable: boolean): FieldErrors {
  const errors: FieldErrors = {};

  if (!form.classType.trim()) errors.classType = 'Class type is required.';
  if (!form.location.trim()) errors.location = 'Location is required.';
  if (dateEditable && !form.date) errors.date = 'Pick a date for this class.';
  if (!form.startTime) errors.startTime = 'Pick a start time.';

  const duration = Number(form.durationMinutes);
  if (!form.durationMinutes.trim() || !Number.isInteger(duration) || duration <= 0) {
    errors.durationMinutes = 'Enter how many minutes the class runs.';
  }

  // Empty is rejected rather than read as 0. Sending 0 should be something a
  // teacher types, never something a cleared field produces.
  const rate = Number(form.hourlyRate);
  if (!form.hourlyRate.trim() || Number.isNaN(rate) || rate < 0) {
    errors.hourlyRate = 'Enter an hourly rate — 0 if this class is unpaid.';
  }

  return errors;
}

export function StudioClassEditForm({
  studioClassId,
  dateEditable,
  initial,
}: StudioClassEditFormProps) {
  const router = useRouter();
  const minDate = useTodayLocal();
  const [form, setForm] = useState<FormState>(() => toFormState(initial));
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    // A marker left over from the previous values describes values that are
    // no longer on screen — same reason StudentCountEditor clears on change.
    setSuccess('');
    setError('');
    setFieldErrors((prev) => (prev[key] === undefined ? prev : { ...prev, [key]: undefined }));
  }

  async function handleSave() {
    const errors = validate(form, dateEditable);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setSuccess('');
      setError('');
      return;
    }

    setSaving(true);
    setSuccess('');
    setError('');
    setFieldErrors({});
    // Whether the server was reached AND answered, either way — the two states
    // that make re-reading the page worthwhile. A validation return above never
    // gets here, and a thrown fetch leaves it false.
    let answered = false;
    try {
      // Everything in `StudioClassEditInitial` goes in every payload — the pins
      // above are what keep that set honest against the schema. `date` does
      // not: the API refuses its PRESENCE on a row whose `dateEditable` is
      // false, not a change to it, so re-sending the unchanged date of a
      // generated row would 409. Omission is what keeps the form honest with
      // gate 2.
      //
      // Trimmed, because `z.string().min(1)` counts characters and accepts
      // `'   '` — and `location` is the detail page's heading, so a whitespace
      // save would blank it at 200.
      const payload: UpdateStudioClassWire = {
        classType: form.classType.trim(),
        location: form.location.trim(),
        startTime: form.startTime,
        durationMinutes: Number(form.durationMinutes),
        hourlyRate: Number(form.hourlyRate),
      };
      if (dateEditable) {
        payload.date = form.date;
      }
      const res = await fetch(`/api/studio-classes/${studioClassId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      answered = true;
      if (res.ok) {
        setSuccess('Saved');
      } else {
        setError(await readErrorMessage(res, 'Could not save. Please try again.'));
      }
    } catch (err) {
      // Bound and logged rather than swallowed by a bare `catch {}`, which
      // leaves nothing to log without editing the line. What reaches here is
      // `fetch` itself failing — offline, DNS, an aborted connection — since
      // `readErrorMessage` handles its own unreadable body and returns the
      // fallback copy instead of throwing.
      console.error('studio class edit save failed', err);
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSaving(false);
      // OUTSIDE the try, and on refusal as well as success.
      //
      // Outside, because `router.refresh()` throwing would otherwise be caught
      // above and reported as a network failure for a write the server had
      // already committed — the teacher would retry a save that succeeded.
      //
      // On refusal, because a 409 means the server knows something this page
      // does not. A class dated today is editable, so a form left open across
      // local midnight makes every later save fail identically — gate 1 now
      // refuses the fields this form always sends. Re-reading lets the server
      // page's `!scheduleEditable` branch redirect to the detail page, which is
      // the right end state. `class-edit-form.tsx` carries the same reasoning.
      if (answered) router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-[480px]">
      <section className="flex flex-col gap-4">
        <Input
          label="Class type"
          value={form.classType}
          error={fieldErrors.classType}
          onChange={(e) => set('classType', e.target.value)}
        />
        <Input
          label="Location"
          value={form.location}
          error={fieldErrors.location}
          onChange={(e) => set('location', e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Date"
            type="date"
            // A hint, not a guard (#249). Gate 3 refuses a past date on its own
            // and answers 409; this only keeps the picker from offering one.
            //
            // Through the hook rather than calling `todayLocal()` here: this
            // form is server-rendered before it is hydrated, and the server's
            // zone is the container's — UTC — not the teacher's.
            // `useTodayLocal` withholds the bound until the browser can supply
            // it. Its docblock has the measurement.
            min={minDate}
            value={form.date}
            disabled={!dateEditable}
            error={fieldErrors.date}
            onChange={(e) => set('date', e.target.value)}
          />
          <Input
            label="Start time"
            type="time"
            value={form.startTime}
            error={fieldErrors.startTime}
            onChange={(e) => set('startTime', e.target.value)}
          />
        </div>
        {!dateEditable && (
          <p className="type-caption max-w-[420px]">
            {STUDIO_CLASS_EDIT_REFUSALS.generated_date.message}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Duration (minutes)"
            type="number"
            value={form.durationMinutes}
            error={fieldErrors.durationMinutes}
            onChange={(e) => set('durationMinutes', e.target.value)}
          />
          <Input
            label="Hourly rate (€)"
            type="number"
            step="0.01"
            value={form.hourlyRate}
            error={fieldErrors.hourlyRate}
            onChange={(e) => set('hourlyRate', e.target.value)}
          />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save changes'}
        </Button>
        {/* One slot, never both: "Saved" and a failure describe the same click. */}
        {error
          ? <span role="alert" className="type-caption text-danger">{error}</span>
          : success && <span className="type-caption text-teal">{success}</span>}
      </div>
    </div>
  );
}
