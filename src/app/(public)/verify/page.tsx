'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function VerifyContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'verifying' | 'error'>('verifying');

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      return;
    }

    fetch('/api/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Verification failed');
        return res.json();
      })
      .then((json) => {
        router.push(json.data.redirectTo);
      })
      .catch(() => {
        setStatus('error');
      });
  }, [searchParams, router]);

  return (
    <>
      <h1 className="font-heading text-2xl font-bold text-dark mb-4">
        {status === 'verifying' ? 'Verifying...' : 'Verification failed'}
      </h1>
      {status === 'error' && (
        <p className="text-brown">
          This link is invalid or has expired.{' '}
          <a href="/login" className="text-teal underline">Try again</a>
        </p>
      )}
    </>
  );
}

export default function VerifyPage() {
  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <Suspense
        fallback={
          <h1 className="font-heading text-2xl font-bold text-dark mb-4">
            Verifying...
          </h1>
        }
      >
        <VerifyContent />
      </Suspense>
    </div>
  );
}
