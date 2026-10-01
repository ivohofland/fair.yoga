'use client';

import { useState } from 'react';
import type { z } from 'zod';
import type { ReminderChannel, ReminderTiming } from '@prisma/client';
import type { updateStudentSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  REMINDER_CHANNEL_OPTIONS,
  REMINDER_TIMING_OPTIONS,
  isReminderChannel,
  isReminderTiming,
} from '@/lib/reminder-options';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';

interface NotificationsFormProps {
  studentId: string;
  emailNotifications: boolean;
  classReminder: ReminderTiming;
  classReminderChannel: ReminderChannel;
}

type UpdateStudentWire = z.infer<typeof updateStudentSchema>;

interface NotificationsBody {
  emailNotifications: boolean;
  classReminder: ReminderTiming;
  classReminderChannel: ReminderChannel;
}

/**
 * #136, #400. Reverse pin only: `updateStudentSchema` is `.strict()`, so a
 * key this form sent that the schema had dropped would 400 at runtime, and
 * this catches it at compile time instead. No forward pin — the schema
 * carries fields this form has no business rendering.
 */
const _formHasNoExtras: NoneOf<Exclude<keyof NotificationsBody, keyof UpdateStudentWire>> = true;
void _formHasNoExtras;

export function NotificationsForm({
  studentId,
  emailNotifications,
  classReminder,
  classReminderChannel,
}: NotificationsFormProps) {
  const [emails, setEmails] = useState(emailNotifications);
  const [reminder, setReminder] = useState(classReminder);
  const [reminderChannel, setReminderChannel] = useState(classReminderChannel);
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
        classReminder: reminder,
        classReminderChannel: reminderChannel,
      };
      const res = await fetch(`/api/students/${studentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSaved(true);
      } else {
        console.error('student notification prefs save failed (HTTP)', res.status);
        setError(await readErrorMessage(res, 'Could not save. Try again.'));
      }
    } catch (err) {
      // Bound and logged rather than discarded. This form never reads the
      // response body, so what reaches here is `fetch` itself failing —
      // offline, DNS, an aborted connection — and without the log nothing
      // records which.
      logRequestFailure('notifications-form', {}, err);
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
          spots, payment requests — are still emailed even when this is off. Class reminders follow their own setting below.
        </p>
      </section>

      <fieldset>
        <legend className="type-subtitle">Class reminder</legend>
        <div className="mt-3 flex max-w-[280px] flex-col gap-3">
          <Select
            id="reminder-when"
            label="When"
            value={reminder}
            onChange={(e) => {
              if (isReminderTiming(e.target.value)) {
                setReminder(e.target.value);
                setSaved(false);
              }
            }}
          >
            {REMINDER_TIMING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
          <Select
            id="reminder-how"
            label="How"
            value={reminderChannel}
            disabled={reminder === 'off'}
            onChange={(e) => {
              if (isReminderChannel(e.target.value)) {
                setReminderChannel(e.target.value);
                setSaved(false);
              }
            }}
          >
            {REMINDER_CHANNEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
      </fieldset>

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
