'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updatePrivacySchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

export interface TeacherPrivacyValues {
  shareFullName: boolean;
  shareEmail: boolean;
  sharePhone: boolean;
  shareBirthday: boolean;
  shareAddress: boolean;
  receiveComms: boolean;
}

type UpdatePrivacyWire = z.infer<typeof updatePrivacySchema>;
type PrivacyBody = TeacherPrivacyValues & { teacherId: string };

/**
 * #136. The body is already `{ teacherId, ...values }`, spread-derived from
 * `TeacherPrivacyValues` above — only the pins against `updatePrivacySchema`
 * were missing.
 */
const _formCoversUpdate: NoneOf<Exclude<keyof UpdatePrivacyWire, keyof PrivacyBody>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof PrivacyBody, keyof UpdatePrivacyWire>> = true;
void _formCoversUpdate;
void _formHasNoExtras;

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
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState('');

  function toggle(key: keyof TeacherPrivacyValues, checked: boolean) {
    setValues((v) => ({ ...v, [key]: checked }));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const payload: PrivacyBody = { teacherId, ...values };
      const res = await fetch(`/api/students/${studentId}/privacy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSaved(true);
      } else if (res.status === 403) {
        // The route 403s a teacher this student has no TeacherStudent link to,
        // and `deleteTeacherAccount` in services/gdpr.ts hard-deletes every one
        // of a teacher's links — regardless of whether the student has claimed
        // their account — so this card can be on screen when its link
        // disappears. "Try again" would be advice for a state no retry can
        // reach. (The CRM-removal route cannot produce this: it refuses to
        // remove a student with `claimedAt` set, and any student who can see
        // this page is signed in and therefore claimed.)
        setError('This teacher is no longer connected to your account, so these settings no longer apply.');
      } else {
        setError('Could not save. Try again.');
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Severs the `TeacherStudent` link (`unlinkTeacher`,
   * services/invitations.ts). Registrations and payments are untouched —
   * only the copy below promises that, this call has no say in it — and a
   * `TeacherBlock` goes down that stops the teacher re-adding this student,
   * which booking one of their classes is the only thing that lifts.
   * `router.refresh()` on success is what drops this card from the list.
   */
  async function handleUnlink() {
    setUnlinking(true);
    setUnlinkError('');
    try {
      const res = await fetch(`/api/teacher-links/${teacherId}`, { method: 'DELETE' });
      if (res.ok) {
        router.refresh();
        return;
      }
      setUnlinkError(await readErrorMessage(res, 'Could not remove this teacher. Try again.'));
    } catch {
      setUnlinkError('Network error. Try again.');
    } finally {
      setUnlinking(false);
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

      <div className="mt-5 pt-4 border-t border-border">
        {confirmingUnlink ? (
          <div className="flex flex-col gap-3">
            <p className="type-body">
              Your past bookings and any payments with {teacherName} stay. They won&apos;t be
              able to add you again — but you can always reconnect by booking one of their
              classes.
            </p>
            <div className="flex items-center gap-3">
              <Button variant="destructive" onClick={handleUnlink} disabled={unlinking}>
                {unlinking ? 'Removing...' : 'Remove teacher'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setConfirmingUnlink(false)}
                disabled={unlinking}
              >
                Cancel
              </Button>
            </div>
            {unlinkError && <p className="type-caption text-danger">{unlinkError}</p>}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingUnlink(true)}
            className="type-label text-danger"
          >
            Remove this teacher
          </button>
        )}
      </div>
    </section>
  );
}
