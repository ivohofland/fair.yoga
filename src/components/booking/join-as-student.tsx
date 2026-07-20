'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface JoinAsStudentProps {
  /** The signed-in teacher's first name — this is their account. */
  firstName: string;
}

// A teacher on another teacher's booking page: one tap adds the student
// side to their account, then the normal booking flow takes over.
export function JoinAsStudent({ firstName }: JoinAsStudentProps) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function handleJoin() {
    setState('working');
    try {
      const res = await fetch('/api/account/student-profile', { method: 'POST' });
      if (!res.ok) {
        setMessage(await readErrorMessage(res, 'Could not set up your student side. Try again.'));
        setState('error');
        return;
      }
      router.refresh();
    } catch {
      setMessage('Network error. Try again.');
      setState('error');
    }
  }

  return (
    <div className="bg-teal-tint rounded-card p-5 max-w-[420px]">
      <p className="type-subtitle">You&apos;re signed in as {firstName}</p>
      <p className="type-body mt-2">
        Set up your student side to join this class — your income tier picks
        your price, and you can change it any time.
      </p>
      <div className="mt-4">
        <Button onClick={handleJoin} disabled={state === 'working'} className="w-full">
          {state === 'working' ? 'One moment...' : 'Join as a student'}
        </Button>
      </div>
      {state === 'error' && (
        <p className="text-[13px] leading-[1.4] text-danger mt-3">{message}</p>
      )}
    </div>
  );
}
