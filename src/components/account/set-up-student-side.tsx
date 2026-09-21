'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';
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
      // A student side that already exists answers 200 `unchanged`, so every
      // non-2xx here is a refusal, a 409 included.
      if (!res.ok) {
        setMessage(await readErrorMessage(res, 'Could not set up your student side. Try again.'));
        setState('error');
        return;
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
