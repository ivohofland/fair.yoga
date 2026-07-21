'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export interface TeacherPrivacyValues {
  shareFullName: boolean;
  shareEmail: boolean;
  sharePhone: boolean;
  shareBirthday: boolean;
  shareAddress: boolean;
  receiveComms: boolean;
}

interface TeacherPrivacyCardProps {
  studentId: string;
  teacherId: string;
  teacherName: string;
  initial: TeacherPrivacyValues;
}

const SHARE_FIELDS: Array<{ key: keyof TeacherPrivacyValues; label: string }> = [
  { key: 'shareFullName', label: 'Full last name' },
  { key: 'shareEmail', label: 'Email address' },
  { key: 'sharePhone', label: 'Phone number' },
  { key: 'shareBirthday', label: 'Birthday' },
  { key: 'shareAddress', label: 'Address' },
];

export function TeacherPrivacyCard({
  studentId,
  teacherId,
  teacherName,
  initial,
}: TeacherPrivacyCardProps) {
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  function toggle(key: keyof TeacherPrivacyValues, checked: boolean) {
    setValues((v) => ({ ...v, [key]: checked }));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await fetch(`/api/students/${studentId}/privacy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacherId, ...values }),
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
    <section className="bg-sand-soft border border-border rounded-card p-5">
      <h2 className="type-label text-ink font-semibold mb-3">{teacherName}</h2>
      <div className="flex flex-col">
        {SHARE_FIELDS.map((field) => (
          <label key={field.key} className="flex items-center gap-3 min-h-11">
            <input
              type="checkbox"
              checked={values[field.key]}
              onChange={(e) => toggle(field.key, e.target.checked)}
              className="w-5 h-5 accent-teal"
            />
            <span className="type-body">{field.label}</span>
          </label>
        ))}
      </div>
      <label className="flex items-center gap-3 min-h-11 mt-3 pt-3 border-t border-border">
        <input
          type="checkbox"
          checked={values.receiveComms}
          onChange={(e) => toggle('receiveComms', e.target.checked)}
          className="w-5 h-5 accent-teal"
        />
        <span className="type-body">Receive announcements from this teacher</span>
      </label>
      <div className="flex items-center gap-3 mt-4">
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
        {saved && <span className="type-caption text-teal">Saved</span>}
      </div>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
    </section>
  );
}
