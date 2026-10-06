'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Currency } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/format';
import { logRequestFailure, readError, readErrorMessage } from '@/lib/client-errors';

interface ArchiveStudentButtonProps {
  studentId: string;
  studentName: string;
  isArchived: boolean;
  outstanding: { ids: string[]; total: number };
  currency: Currency;
}

/** No body for a plain archive/unarchive; a JSON `waivePaymentIds` body for a waive-and-archive. */
function archivePatch(studentId: string, state: 'archived' | 'unarchived', body?: { waivePaymentIds: string[] }): Promise<Response> {
  const init: RequestInit = { method: 'PATCH' };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetch(`/api/students/${studentId}?state=${state}`, init);
}

export function ArchiveStudentButton({ studentId, studentName, isArchived, outstanding, currency }: ArchiveStudentButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const waiveRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  // Set when the confirm closes, so focus goes back to the main button
  // rather than dropping to the page once the confirm's buttons unmount.
  const returnFocus = useRef(false);

  // Opening the confirm focuses its action; closing it returns focus to the
  // main button once that button is enabled again.
  useEffect(() => {
    if (confirming) {
      waiveRef.current?.focus();
      return;
    }
    if (returnFocus.current && !loading) {
      returnFocus.current = false;
      mainRef.current?.focus();
    }
  }, [confirming, loading]);

  function closeConfirm() {
    returnFocus.current = true;
    setConfirming(false);
  }

  async function handleUnarchive() {
    setLoading(true);
    setError('');
    try {
      const res = await archivePatch(studentId, 'unarchived');
      if (res.ok) {
        router.push('/students');
        return;
      }
      // Success navigates away, so a failure that says nothing is
      // indistinguishable from a click that never registered — the button
      // re-enables and the page is unchanged. Same handling as
      // `toggle-template-button.tsx`, the other caption-styled PATCH toggle.
      setError(await readErrorMessage(res, 'Could not unarchive this student. Try again.'));
    } catch (err) {
      logRequestFailure('archive-student-button-unarchive', { studentId }, err);
      setError('Network error. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleArchive(body?: { waivePaymentIds: string[] }) {
    setLoading(true);
    setError('');
    try {
      const res = await archivePatch(studentId, 'archived', body);
      if (res.ok) {
        router.push('/students');
        return;
      }
      const { code, message } = await readError(res, 'Could not archive this student. Try again.');
      // The waive ids named in `body` were an offer built from a prop that can
      // go stale (`outstanding` is read once, server-side, when the page
      // rendered) — the server's compare-and-swap is the gate. Closing the
      // confirm here rather than retrying with the same stale ids means the
      // next tap of the main button reopens it with fresh numbers, once
      // `router.refresh()` has re-read them.
      closeConfirm();
      if (code === 'STUDENT_HAS_OUTSTANDING_PAYMENTS') {
        router.refresh();
      }
      setError(message);
    } catch (err) {
      logRequestFailure(
        'archive-student-button-archive',
        { studentId, waivedCount: body?.waivePaymentIds.length },
        err,
      );
      setError('Network error. Try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleClick() {
    if (isArchived) {
      void handleUnarchive();
      return;
    }
    if (outstanding.ids.length === 0) {
      void handleArchive();
      return;
    }
    // A fresh confirm: the last refusal's message was about the offer it closed.
    setError('');
    setConfirming(true);
  }

  if (confirming) {
    const n = outstanding.ids.length;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-brown">
          {studentName} still owes {formatMoney(outstanding.total, currency)} across {n} {n === 1 ? 'payment' : 'payments'}. Archiving waives {n === 1 ? 'it' : 'them'}.
        </p>
        <div className="flex gap-3">
          <Button
            ref={waiveRef}
            variant="primary"
            onClick={() => void handleArchive({ waivePaymentIds: outstanding.ids })}
            disabled={loading}
          >
            {loading ? 'Archiving...' : 'Waive and archive'}
          </Button>
          <Button variant="secondary" onClick={closeConfirm} disabled={loading}>
            Cancel
          </Button>
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <button
        ref={mainRef}
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="type-caption"
      >
        {loading
          ? (isArchived ? 'Unarchiving...' : 'Archiving...')
          : (isArchived ? 'Unarchive student' : 'Archive student')}
      </button>
      {error && <p role="alert" className="text-sm text-danger mt-2">{error}</p>}
    </div>
  );
}
