'use client';

import { useState } from 'react';
import type { z } from 'zod';
import type { StudentReminderPref } from '@prisma/client';
import type { updateStudentSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';

interface NotificationsFormProps {
  studentId: string;
  emailNotifications: boolean;
  reminderPref: string;
}

type UpdateStudentWire = z.infer<typeof updateStudentSchema>;

interface NotificationsBody {
  emailNotifications: boolean;
  reminderPref: StudentReminderPref;
}

/**
 * #136, #400. Reverse pin only, deliberately. This form shares
 * `updateStudentSchema` with `tier-form.tsx` and `name-form.tsx`.
 * Each form sends only a subset of the schema fields. A forward pin
 * would name fields this form has no business rendering.
 *
 * What the reverse pin still buys: `updateStudentSchema` is `.strict()`, so a
 * key it dropped would 400 at runtime. This catches that at compile time.
 */
const _formHasNoExtras: NoneOf<Exclude<keyof NotificationsBody, keyof UpdateStudentWire>> = true;
void _formHasNoExtras;

/**
 * `StudentReminderPref`, not `ReminderPref` — the codebase carries both, and
 * the other one (`morning_of | evening_before | one_hour_before`) governs the
 * *teacher's* `defaultReminder`. Nothing but this pin connects these four
 * option values to the right enum, and the two are one careless import apart.
 */
const REMINDER_OPTIONS = [
  { value: 'eve', label: 'Evening before' },
  { value: 'morning', label: 'Morning of class' },
  { value: 'one_hour', label: 'One hour before' },
  { value: 'off', label: 'No reminders' },
] as const;

type ReminderOption = (typeof REMINDER_OPTIONS)[number]['value'];

const _offersEveryReminder: NoneOf<Exclude<StudentReminderPref, ReminderOption>> = true;
const _noStaleReminder: NoneOf<Exclude<ReminderOption, StudentReminderPref>> = true;
void _offersEveryReminder;
void _noStaleReminder;

/**
 * `reminderPref` arrives as `string` — both the prop (Prisma's enum flows
 * through the server component as a plain string) and `e.target.value` off
 * the `<select>`. This narrows either to `ReminderOption` without an
 * assertion, reading the options array rather than a second list, the same
 * way `template-form.tsx`'s `isCancelDeadline`/`isAutoCancelCheck` do.
 */
function isReminderOption(v: string): v is ReminderOption {
  return REMINDER_OPTIONS.some((o) => o.value === v);
}

export function NotificationsForm({
  studentId,
  emailNotifications,
  reminderPref,
}: NotificationsFormProps) {
  const [emails, setEmails] = useState(emailNotifications);
  const [reminder, setReminder] = useState<ReminderOption>(
    isReminderOption(reminderPref) ? reminderPref : REMINDER_OPTIONS[0].value,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const payload: NotificationsBody = {
        emailNotifications: emails,
        reminderPref: reminder,
      };
      const res = await fetch(`/api/students/${studentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSaved(true);
      } else {
        setError('Could not save. Try again.');
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <label className="flex items-center gap-3 min-h-12">
          <input
            type="checkbox"
            checked={emails}
            onChange={(e) => { setEmails(e.target.checked); setSaved(false); }}
            className="w-5 h-5 accent-teal"
          />
          <span className="type-body">Email me when I miss an in-app notification</span>
        </label>
        <p className="type-caption mt-1 max-w-[420px]">
          Essential messages about your bookings — cancellations, waitlist
          spots, payment requests — are still emailed even when this is off.
        </p>
        <div className="mt-3 max-w-[280px]">
          <Select
            label="Class reminder"
            value={reminder}
            onChange={(e) => {
              if (isReminderOption(e.target.value)) {
                setReminder(e.target.value);
                setSaved(false);
              }
            }}
          >
            {REMINDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save notifications'}
        </Button>
        {saved && <span className="type-caption text-teal">Saved</span>}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
