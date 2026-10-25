'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { logRequestFailure } from '@/lib/client-errors';
import { givePagePath } from '@/lib/notification-links';
import { formatDayHeader } from '@/lib/format';

interface DonationPromptProps {
  registrationId: string;
  classId: string;
  classType: string;
  /** ISO instant of the class's date. */
  date: string;
}

/** A past donation class's row offer: a link to how to give, and a Hide that retires it. */
export function DonationPrompt({ registrationId, classId, classType, date }: DonationPromptProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function hide() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/registrations/${registrationId}/donation-prompt/hide`, { method: 'POST' });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      router.refresh();
    } catch (err) {
      logRequestFailure('donation-prompt', { registrationId }, err);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex items-center gap-4">
      <Link
        href={givePagePath(classId)}
        aria-label={`Give if you'd like — ${classType}, ${formatDayHeader(new Date(date))}`}
        className="inline-flex items-center h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint no-underline"
      >
        Give if you&apos;d like
      </Link>
      <button type="button" onClick={hide} disabled={busy} className="type-label text-teal min-h-[44px] px-1">
        Hide
      </button>
      {failed && (
        <p role="alert" className="type-caption text-danger">
          Could not hide this. Try again.
        </p>
      )}
    </div>
  );
}
