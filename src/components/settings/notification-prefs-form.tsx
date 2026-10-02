'use client';

import { useState } from 'react';
import type { z } from 'zod';
import type { TeacherBookingNotifications } from '@prisma/client';
import type { updateTeacherSchema } from '@/lib/schemas';
import type { TeacherNotificationPrefs } from '@/services/notification-policy';
import type { TeacherPushPrefs } from '@/lib/push-policy';
import type { NoneOf } from '@/lib/type-pins';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { PushDeviceControl } from '@/components/settings/push-device-control';
import {
  REMINDER_CHANNEL_OPTIONS,
  REMINDER_TIMING_OPTIONS,
  isReminderChannel,
  isReminderTiming,
} from '@/lib/reminder-options';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';

export type NotificationPrefsBody = TeacherNotificationPrefs & TeacherPushPrefs;

interface NotificationPrefsFormProps {
  teacherId: string;
  initial: NotificationPrefsBody;
  vapidPublicKey: string | null;
}

type UpdateTeacherWire = z.infer<typeof updateTeacherSchema>;

/**
 * Reverse pin: `updateTeacherSchema` is `.strict()`, so a key sent here that
 * the schema dropped would 400 at runtime; this fails at compile time instead.
 */
const _formHasNoExtras: NoneOf<Exclude<keyof NotificationPrefsBody, keyof UpdateTeacherWire>> = true;
void _formHasNoExtras;

const BOOKING_OPTIONS = [
  { value: 'inbox_and_email', label: 'In the inbox, and emailed if I miss it' },
  { value: 'inbox_only', label: 'In the inbox only' },
  { value: 'off', label: 'Off' },
] as const satisfies ReadonlyArray<{ value: TeacherBookingNotifications; label: string }>;

type BookingOption = (typeof BOOKING_OPTIONS)[number]['value'];

const _offersEveryChoice: NoneOf<Exclude<TeacherBookingNotifications, BookingOption>> = true;
void _offersEveryChoice;

export function NotificationPrefsForm({ teacherId, initial, vapidPublicKey }: NotificationPrefsFormProps) {
  const [booking, setBooking] = useState<TeacherBookingNotifications>(initial.bookingNotifications);
  const [completed, setCompleted] = useState(initial.emailOnClassCompleted);
  const [invitation, setInvitation] = useState(initial.emailOnInvitation);
  const [reminder, setReminder] = useState(initial.classReminder);
  const [reminderChannel, setReminderChannel] = useState(initial.classReminderChannel);
  const [autoCancelled, setAutoCancelled] = useState(initial.pushAutoCancelled);
  const [pushNewBookings, setPushNewBookings] = useState(initial.pushBookings);
  const [pushCompleted, setPushCompleted] = useState(initial.pushClassCompleted);
  const [pushReminders, setPushReminders] = useState(initial.pushClassReminders);
  const [pushInvitation, setPushInvitation] = useState(initial.pushInvitations);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const payload: NotificationPrefsBody = {
        bookingNotifications: booking,
        emailOnClassCompleted: completed,
        emailOnInvitation: invitation,
        classReminder: reminder,
        classReminderChannel: reminderChannel,
        pushAutoCancelled: autoCancelled,
        pushBookings: pushNewBookings,
        pushClassCompleted: pushCompleted,
        pushClassReminders: pushReminders,
        pushInvitations: pushInvitation,
      };
      const res = await fetch(`/api/teachers/${teacherId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSaved(true);
      } else {
        console.error('teacher notification prefs save failed (HTTP)', res.status);
        setError(await readErrorMessage(res, 'Could not save. Try again.'));
      }
    } catch (err) {
      logRequestFailure('notification-prefs-form', {}, err);
      setError('Network error. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <fieldset>
        <legend className="type-subtitle">New booking</legend>
        {BOOKING_OPTIONS.map((option) => (
          <label key={option.value} className="flex items-center gap-3 min-h-12">
            <input
              type="radio"
              name="bookingNotifications"
              value={option.value}
              checked={booking === option.value}
              onChange={() => { setBooking(option.value); setSaved(false); }}
              className="w-5 h-5 accent-teal"
            />
            <span className="type-body">{option.label}</span>
          </label>
        ))}
        <p className="type-caption mt-1 max-w-[420px]">
          Bookings always show on your schedule — this only changes whether you&apos;re told about each one.
        </p>
      </fieldset>

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

      <fieldset>
        <legend className="type-subtitle">Other emails</legend>
        <label className="flex items-center gap-3 min-h-12">
          <input
            type="checkbox"
            checked={completed}
            onChange={(e) => { setCompleted(e.target.checked); setSaved(false); }}
            className="w-5 h-5 accent-teal"
          />
          <span className="type-body">Email me when I miss a class-completed summary</span>
        </label>
        <label className="flex items-center gap-3 min-h-12">
          <input
            type="checkbox"
            checked={invitation}
            onChange={(e) => { setInvitation(e.target.checked); setSaved(false); }}
            className="w-5 h-5 accent-teal"
          />
          <span className="type-body">Email me when I miss an invitation</span>
        </label>
      </fieldset>

      <section>
        <h2 className="type-subtitle">Class auto-cancelled</h2>
        <p className="type-caption mt-1 max-w-[420px]">
          Always emailed if you miss it — so you know the class won&apos;t run.
        </p>
      </section>

      <fieldset>
        <legend className="type-subtitle">Push notifications</legend>
        <div className="mt-3">
          <PushDeviceControl vapidPublicKey={vapidPublicKey} installHref="/settings" />
        </div>
        <div className="mt-4 flex flex-col gap-1">
          <label className="flex items-center gap-3 min-h-12">
            <input
              type="checkbox"
              checked={autoCancelled}
              onChange={(e) => { setAutoCancelled(e.target.checked); setSaved(false); }}
              className="w-5 h-5 accent-teal"
            />
            <span className="type-body">Auto-cancelled classes</span>
          </label>
          <label className="flex items-center gap-3 min-h-12">
            <input
              type="checkbox"
              checked={pushNewBookings}
              onChange={(e) => { setPushNewBookings(e.target.checked); setSaved(false); }}
              className="w-5 h-5 accent-teal"
            />
            <span className="type-body">New bookings</span>
          </label>
          <label className="flex items-center gap-3 min-h-12">
            <input
              type="checkbox"
              checked={pushCompleted}
              onChange={(e) => { setPushCompleted(e.target.checked); setSaved(false); }}
              className="w-5 h-5 accent-teal"
            />
            <span className="type-body">Class completed</span>
          </label>
          <label className="flex items-center gap-3 min-h-12">
            <input
              type="checkbox"
              checked={pushReminders}
              onChange={(e) => { setPushReminders(e.target.checked); setSaved(false); }}
              className="w-5 h-5 accent-teal"
            />
            <span className="type-body">Class reminders</span>
          </label>
          <label className="flex items-center gap-3 min-h-12">
            <input
              type="checkbox"
              checked={pushInvitation}
              onChange={(e) => { setPushInvitation(e.target.checked); setSaved(false); }}
              className="w-5 h-5 accent-teal"
            />
            <span className="type-body">Invitations</span>
          </label>
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
