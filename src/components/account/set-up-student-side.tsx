'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readError } from '@/lib/client-errors';
import { STUDENT_INVITATION_PATH } from '@/lib/notification-links';

// Adding the student side is the account holder's own act; the invitation is
// answered on the student page it leads to.
export function SetUpStudentSide() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function handleSetUp() {
    setState('working');
    try {
      const res = await fetch('/api/account/student-profile', { method: 'POST' });
      if (!res.ok) {
        // Only `ALREADY_STUDENT` means the student side is already there, and
        // so only that 409 is success — the student page is where this button
        // leads either way. Keyed on the code rather than the status because
        // this route answers 409 for other reasons too, and `classifyApiError`
        // turns a unique-constraint violation that escapes the route's own
        // catch into a code-less one. Treating those as success navigated to a
        // page this account cannot open, which bounces it to the schedule
        // saying nothing at all.
        const { code, message } = await readError(
          res,
          'Could not set up your student side. Try again.',
        );
        if (!(res.status === 409 && code === 'ALREADY_STUDENT')) {
          setMessage(message);
          setState('error');
          return;
        }
      }
      router.push(STUDENT_INVITATION_PATH);
      // If the navigation never commits, don't leave a dead button behind.
      setTimeout(() => setState('idle'), 4000);
    } catch {
      setMessage('Network error. Try again.');
      setState('error');
    }
  }

  return (
    <div>
      <Button onClick={handleSetUp} disabled={state === 'working'} className="w-full">
        {state === 'working' ? 'One moment...' : 'Set up student side'}
      </Button>
      {state === 'error' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger mt-3">{message}</p>
      )}
    </div>
  );
}
