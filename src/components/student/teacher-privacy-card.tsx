'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updatePrivacySchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Button } from '@/components/ui/button';
import { SettledNotice } from '@/components/ui/settled-notice';
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
  /**
   * True when this `TeacherStudent` link is archived on the teacher's side
   * (their CRM filing action, `isArchived` on the row). Archiving must not
   * remove the student's own controls over the same link — see the page's
   * comment on why its query no longer filters this out (review F3) — so
   * this only adds a factual note, never hides the card or its actions.
   */
  archivedByTeacher?: boolean;
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
  archivedByTeacher = false,
}: TeacherPrivacyCardProps) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState('');
  const [unlinked, setUnlinked] = useState(false);

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
   * which booking one of their classes is the only thing that lifts. The
   * same call writes this student's `StudentPrivacy` row for this teacher
   * to every share off and announcements off, which is what the first
   * sentence of the confirmation copy below promises; deleting the link
   * alone would have left both switched on with no way back to this card.
   * `router.refresh()` on success is what drops this card from the list.
   *
   * `unlinking` is deliberately not reset on success (review F7): the DELETE
   * has committed, so a second click would earn a 404 ("Teacher link not
   * found") in red over an action that worked. F7's own remedy — leaving the
   * flag true — froze this cluster whenever the refresh did not commit, so
   * #40 replaced it with `unlinked`: the card settles, which blocks the second
   * DELETE the same way and still leaves the student a control that works.
   */
  async function handleUnlink() {
    setUnlinking(true);
    setUnlinkError('');
    try {
      const res = await fetch(`/api/teacher-links/${teacherId}`, { method: 'DELETE' });
      if (res.ok) {
        setUnlinked(true);
        router.refresh();
        return;
      }
      setUnlinkError(await readErrorMessage(res, 'Could not remove this teacher. Try again.'));
      setUnlinking(false);
    } catch {
      setUnlinkError('Network error. Try again.');
      setUnlinking(false);
    }
  }

  return (
    <section className="bg-sand-soft border border-border rounded-card p-5">
      <div className="mb-3">
        {/* h3: subordinate to the page's "Your teachers" h2 (review F8) */}
        <h3 className="type-label text-ink font-semibold">{teacherName}</h3>
        {archivedByTeacher && (
          <p className="type-caption mt-1">
            Archived by {teacherName} in their records — this doesn&apos;t change what you
            control here.
          </p>
        )}
      </div>
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
        {/*
          #40, whole-branch review F2. `unlinked` is tested *first*, ahead of
          `confirmingUnlink` — the ordering `mark-unpaid-button` and
          `pending-invitation-card` get for free, because each early-returns on
          its settled flag above its whole render and so above its own confirm
          branch. Those two are the only siblings this applies to; the rest
          render their notice from an inline ternary with no confirm sub-state
          to be ordered against, so there is nothing there to get for free. Not
          a count, because a count is exactly what a fifth confirm-cluster
          component would silently falsify — the same reason
          `tests/setup/components.ts` and `settled-notice.test.tsx` both refuse
          to carry one. It used to sit
          inside the confirm branch, and Rule 3 un-disabling Cancel opened the
          path that exposed it: confirm → DELETE in flight → Cancel → the
          DELETE resolves ok. `setUnlinked(true)` ran with nothing to render
          it, so the card fell back to the full privacy UI and offered to
          remove a teacher already removed — a committed destructive action,
          reported as if it had never happened, with a `TeacherBlock` behind it
          that only booking one of that teacher's classes can lift.
        */}
        {unlinked ? (
          <SettledNotice label="Removed" actionLabel="Refresh" onAction={() => router.refresh()} />
        ) : confirmingUnlink ? (
          <div className="flex flex-col gap-3">
            <p className="type-body">
              {teacherName} stops sending you announcements, and everything on this card is
              switched off for them. Your past bookings and any payments stay, but any spot
              you&apos;re holding on their waitlists is given up. They won&apos;t be able to add
              you again — but you can always reconnect by booking one of their classes.
            </p>
            <div className="flex items-center gap-3">
              <Button variant="destructive" onClick={handleUnlink} disabled={unlinking}>
                {unlinking ? 'Removing...' : 'Remove teacher'}
              </Button>
              {/*
                #40. Not disabled by `unlinking`: a pure client-side reset,
                and the only way out if the DELETE hangs rather than
                resolving — a case the settled state cannot reach.
              */}
              <Button variant="secondary" onClick={() => setConfirmingUnlink(false)}>
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
