'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface DataAndDeletionProps {
  /** 'student' | 'teacher' — only changes the consequence copy. */
  role: 'student' | 'teacher';
}

// GDPR section: export everything, or delete the account. Deletion is
// anonymization — payment records the other party is entitled to keep
// stay behind without any personal data attached.
export function DataAndDeletion({ role }: DataAndDeletionProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function handleDelete() {
    setDeleting(true);
    setError('');
    try {
      const res = await fetch('/api/account', { method: 'DELETE' });
      if (res.ok) {
        router.push('/');
        router.refresh();
      } else {
        setError('Could not delete the account. Try again.');
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="mt-10 pt-6 border-t border-border">
      <h2 className="type-subtitle mb-1">Your data</h2>
      <p className="type-body max-w-[420px]">
        Download everything fair.yoga holds about you, or delete your account.
      </p>

      <div className="mt-4">
        <a
          href="/api/account/export"
          className="type-label text-teal no-underline"
          download
        >
          Download your data (JSON)
        </a>
      </div>

      <div className="mt-6">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="type-label text-danger"
          >
            Delete account
          </button>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="type-body max-w-[420px]">
              This permanently removes your personal data and signs you out.
              {role === 'student'
                ? ' Past class and payment records stay with your teachers, without your name attached. Upcoming bookings are cancelled.'
                : ' Your upcoming classes are cancelled and registered students notified. Completed classes and payment records stay with your students, without your details attached.'}
            </p>
            <div className="flex gap-3">
              <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete my account'}
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Keep account
              </Button>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
