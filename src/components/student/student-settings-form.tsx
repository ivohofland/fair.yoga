'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { TIER_INFO, TIER_QUOTE } from '@/lib/tiers';

interface StudentSettingsFormProps {
  studentId: string;
  currentTier: number;
  emailNotifications: boolean;
  reminderPref: string;
}

// Tier selection + notification preferences. Your tier applies to every
// class you book; changing it is normal, not an event.
export function StudentSettingsForm({
  studentId,
  currentTier,
  emailNotifications,
  reminderPref,
}: StudentSettingsFormProps) {
  const [tier, setTier] = useState(currentTier);
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
          incomeTier: tier,
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
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="type-subtitle mb-1">Your tier</h2>
        <p className="type-body max-w-[420px]">
          Your price for every class is based on what you can comfortably
          contribute. Tiers are self-reported — no proof needed, and you can
          change yours here at any time.
        </p>
        <p className="type-caption font-heading italic mt-3 mb-4 max-w-[420px]">
          &ldquo;{TIER_QUOTE.text}&rdquo; — {TIER_QUOTE.author}
        </p>
        <div className="flex flex-col gap-3" role="radiogroup" aria-label="Income tier">
          {TIER_INFO.map((t) => {
            const selected = tier === t.tier;
            return (
              <button
                key={t.tier}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => { setTier(t.tier); setSaved(false); }}
                className={`text-left border rounded-card p-5 ${
                  selected ? 'bg-teal-tint border-teal' : 'bg-sand-soft border-border hover:bg-sand'
                }`}
              >
                <div className="type-label text-ink font-semibold">
                  Tier {t.tier} · {t.label}
                </div>
                <div className="type-caption mt-0.5">{t.caption}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="type-subtitle mb-3">Notifications</h2>
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
          {saving ? 'Saving...' : 'Save settings'}
        </Button>
        {saved && <span className="type-caption text-teal">Saved</span>}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
