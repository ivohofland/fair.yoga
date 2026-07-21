'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';

interface NotificationsFormProps {
  studentId: string;
  emailNotifications: boolean;
  reminderPref: string;
}

export function NotificationsForm({
  studentId,
  emailNotifications,
  reminderPref,
}: NotificationsFormProps) {
  const [emails, setEmails] = useState(emailNotifications);
  const [reminder, setReminder] = useState(reminderPref);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await fetch(`/api/students/${studentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailNotifications: emails,
          reminderPref: reminder,
        }),
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
            onChange={(e) => { setReminder(e.target.value); setSaved(false); }}
          >
            <option value="eve">Evening before</option>
            <option value="morning">Morning of class</option>
            <option value="one_hour">One hour before</option>
            <option value="off">No reminders</option>
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
