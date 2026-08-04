'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updateInvitationSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface ContactFormProps {
  invitationId: string;
  initialFirstName: string;
  initialLastName: string;
  initialEmail: string;
}

type UpdateInvitationWire = z.infer<typeof updateInvitationSchema>;
type ContactFormBody = { firstName: string; lastName: string; email: string };

/**
 * #136. `updateInvitationSchema` is `.strict()` with all three fields
 * optional; this form always sends all three, which is a valid subset. Both
 * directions still apply — `.strict()` means a key this form sends that the
 * schema doesn't declare 400s the request rather than silently dropping it.
 */
const _formCoversUpdate: NoneOf<Exclude<keyof UpdateInvitationWire, keyof ContactFormBody>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof ContactFormBody, keyof UpdateInvitationWire>> = true;
void _formCoversUpdate;
void _formHasNoExtras;

export function ContactForm({
  invitationId,
  initialFirstName,
  initialLastName,
  initialEmail,
}: ContactFormProps) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName.trim() || !email.trim()) {
      setError('First name and email are required');
      return;
    }
    setSubmitting(true);
    setError('');

    try {
      const payload: ContactFormBody = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
      };
      const res = await fetch(`/api/invitations/${invitationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // #166: a declined contact's row is a tombstone — the PUT 409s with
        // its own explanation (DECLINED_IS_PERMANENT), which `readErrorMessage`
        // surfaces verbatim instead of a generic retry prompt. Same idiom as
        // `teacher-privacy-card.tsx`'s 403 handling, for the same reason: a
        // retry can't fix a state this specific.
        setError(await readErrorMessage(res, 'Failed to update contact'));
        return;
      }

      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="First name"
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
      />
      <Input
        label="Last name"
        value={lastName}
        onChange={(e) => setLastName(e.target.value)}
      />
      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="mt-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

interface ArchiveContactButtonProps {
  invitationId: string;
  isArchived: boolean;
}

/**
 * No file of its own in the plan for Task 9 — `contact-form.tsx` is the only
 * client component the task creates besides `contact-list.tsx`, and this
 * button's only home, `/students/contacts/[id]/page.tsx`, is a server
 * component (it reads the invitation via prisma directly, matching
 * `(teacher)/students/[id]/page.tsx`) and so cannot hold the click handler
 * itself. Copies `archive-student-button.tsx:18-24`'s query-param idiom
 * exactly, pointed at `/api/invitations` instead of `/api/students`.
 */
export function ArchiveContactButton({ invitationId, isArchived }: ArchiveContactButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/invitations/${invitationId}?state=${isArchived ? 'unarchived' : 'archived'}`,
        { method: 'PATCH' },
      );
      if (res.ok) {
        router.push('/students');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={loading}
      className="type-caption"
    >
      {loading
        ? (isArchived ? 'Unarchiving...' : 'Archiving...')
        : (isArchived ? 'Unarchive contact' : 'Archive contact')}
    </button>
  );
}
