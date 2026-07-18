'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

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
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [error, setError] = useState('');

  // Fetch-then-save instead of a bare <a download>: a failed export must
  // show an error, not download an error payload as the user's "data".
  async function handleExport() {
    setExporting(true);
    setExportError('');
    try {
      const res = await fetch('/api/account/export');
      if (!res.ok) {
        setExportError(await readErrorMessage(res, 'Could not build the export. Try again.'));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `fair-yoga-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Network error. Try again.');
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError('');
    try {
      const res = await fetch('/api/account', { method: 'DELETE' });
      if (res.ok) {
        router.push('/');
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Could not delete the account. Try again.'));
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

      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="type-label text-teal self-start disabled:opacity-50"
        >
          {exporting ? 'Preparing download...' : 'Download your data (JSON)'}
        </button>
        {exportError && <p className="text-sm text-danger">{exportError}</p>}
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
