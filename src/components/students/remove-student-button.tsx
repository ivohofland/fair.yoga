'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface RemoveStudentButtonProps {
  invitationId: string;
  studentName: string;
}

/**
 * #166: repointed at `DELETE /api/invitations/[id]` — its former target,
 * `DELETE /api/students/[id]`, is Task 10's to remove now that nothing
 * creates the unclaimed `Student` row it served. The 409 a declined
 * invitation answers with (`DECLINED_IS_PERMANENT`) arrives through
 * `readErrorMessage` below unchanged; the caller is what decides whether
 * this button renders at all for that case (see
 * `/students/contacts/[id]/page.tsx`), since the fix for "present and
 * failing" belongs before the click, not in the error text.
 */
export function RemoveStudentButton({ invitationId, studentName }: RemoveStudentButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');

  async function handleRemove() {
    setRemoving(true);
    setError('');
    try {
      const res = await fetch(`/api/invitations/${invitationId}`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/students');
      } else {
        setError(await readErrorMessage(res, 'Could not remove the contact. Try again.'));
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setRemoving(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="type-label text-danger"
      >
        Remove contact
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-brown">Remove {studentName} from your contacts?</p>
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleRemove} disabled={removing}>
          {removing ? 'Removing...' : 'Remove'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
