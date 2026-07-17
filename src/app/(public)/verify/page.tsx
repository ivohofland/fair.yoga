'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/icon';

type Status = 'verifying' | 'success' | 'error';
type StepState = 'done' | 'now' | 'pending';
type RailStep = { num: string; text: string; when: string; state: StepState };

function Rail({ steps }: { steps: RailStep[] }) {
  return (
    <ul className="list-none p-0 mt-6 mb-2 border-t border-border">
      {steps.map((s) => {
        const isDone = s.state === 'done';
        const isNow = s.state === 'now';
        const isPending = s.state === 'pending';
        return (
          <li
            key={s.num}
            className={`grid grid-cols-[24px_1fr_auto] gap-x-3 items-center min-h-14 py-2 border-b border-border ${
              isNow ? '-mx-2 px-2 bg-teal-tint rounded-field border-b-transparent' : ''
            }`}
          >
            <span className="flex items-center justify-center">
              {isDone ? (
                <Icon name="check" size={16} className="text-teal" />
              ) : isNow ? (
                <span className="block w-2 h-2 rounded-full bg-teal" />
              ) : (
                <span className="block w-2 h-2 rounded-full border border-brown-light" />
              )}
            </span>
            <span
              className={`text-[15px] ${
                isDone
                  ? 'text-brown'
                  : isPending
                    ? 'text-brown-light'
                    : 'text-ink font-medium'
              }`}
            >
              {s.text}
            </span>
            <span className={`type-caption ${isPending ? 'text-brown-light' : ''}`}>
              {s.when}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function StatusLine({
  variant = 'default',
  children,
}: {
  variant?: 'default' | 'error' | 'done';
  children: React.ReactNode;
}) {
  const pipColor = variant === 'error' ? 'bg-danger' : 'bg-teal';
  return (
    <div className="mt-[18px] type-caption flex items-baseline gap-2">
      <span
        className={`block w-1.5 h-1.5 rounded-full flex-none ${pipColor}`}
        style={{ transform: 'translateY(-2px)' }}
      />
      <span>{children}</span>
    </div>
  );
}

function Fineprint({ children }: { children: React.ReactNode }) {
  return <p className="mt-6 type-caption leading-[1.55]">{children}</p>;
}

function VerifyingState() {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-teal mb-[10px]">One moment</p>
      <h1 className="type-display mb-4">Checking your link</h1>
      <p className="type-body max-w-[360px]">
        You tapped a one-time link. We&apos;re confirming it&apos;s still valid and
        that it was meant for this device.
      </p>
      <Rail
        steps={[
          { num: 'i.', text: 'Link received', when: 'just now', state: 'done' },
          { num: 'ii.', text: 'Checking the token', when: 'in progress', state: 'now' },
          { num: 'iii.', text: 'Opening your dashboard', when: '—', state: 'pending' },
        ]}
      />
      <StatusLine>
        Usually takes under a second. If this lingers, your connection may be slow.
      </StatusLine>
      <Fineprint>
        If you didn&apos;t request this link, you can close the tab &mdash; nothing
        happens without confirmation.
      </Fineprint>
    </div>
  );
}

function SuccessState({ redirectTo }: { redirectTo: string }) {
  const dest = redirectTo || '/';
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-teal mb-[10px]">Welcome back</p>
      <h1 className="type-display mb-4">You&apos;re signed in.</h1>
      <p className="type-body max-w-[360px]">
        The link checked out. Taking you to your schedule now.
      </p>
      <Rail
        steps={[
          { num: 'i.', text: 'Link received', when: 'a moment ago', state: 'done' },
          { num: 'ii.', text: 'Token confirmed', when: 'a moment ago', state: 'done' },
          { num: 'iii.', text: 'Opening your dashboard', when: 'now', state: 'now' },
        ]}
      />
      <StatusLine variant="done">
        Redirecting to{' '}
        <span className="type-number">{dest}</span>
        {' — if it doesn’t load, '}
        <Link href={dest} className="text-teal">
          tap here
        </Link>
        .
      </StatusLine>
      <Fineprint>
        This link is now spent. The next time you sign in, ask for a fresh one from
        the login page.
      </Fineprint>
    </div>
  );
}

function ErrorReason({ children }: { children: React.ReactNode }) {
  return (
    <li className="relative text-[14px] text-brown leading-[1.55] mb-1.5 before:content-['·'] before:absolute before:-left-[14px] before:text-brown">
      {children}
    </li>
  );
}

function ErrorState() {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-danger mb-[10px]">Verification failed</p>
      <h1 className="type-display mb-4">
        This link can&apos;t
        <br />
        be used.
      </h1>
      <p className="type-body max-w-[360px] mb-3">
        It&apos;s either past its ten-minute window, already been used, or doesn&apos;t
        match what we sent. Nothing to worry about &mdash; ask for a fresh one.
      </p>
      <ul className="list-none pl-[18px] mt-3 mb-6">
        <ErrorReason>The link is older than ten minutes</ErrorReason>
        <ErrorReason>It&apos;s already been used to sign in once</ErrorReason>
        <ErrorReason>It was opened on a device that wasn&apos;t expecting it</ErrorReason>
      </ul>
      <div className="flex flex-col gap-3 mt-2">
        <Link
          href="/login"
          className="inline-flex items-center justify-center w-full text-center bg-teal text-cream hover:bg-teal-hover rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
        >
          Send a new link
        </Link>
        <Link
          href="/login"
          className="inline-flex items-center justify-center w-full text-center border-[1.5px] border-teal text-teal hover:bg-teal-tint rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
        >
          Use a different email
        </Link>
      </div>
      <StatusLine variant="error">
        If this keeps happening, write to{' '}
        <a href="mailto:hello@fair.yoga" className="text-teal">
          hello@fair.yoga
        </a>{' '}
        &mdash; a real person will read it.
      </StatusLine>
    </div>
  );
}

function VerifyContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'error');
  const [redirectTo, setRedirectTo] = useState<string>('');

  useEffect(() => {
    if (!token) return;
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
        const dest: string = json.data.redirectTo;
        setRedirectTo(dest);
        setStatus('success');
        setTimeout(() => router.push(dest), 900);
      })
      .catch(() => setStatus('error'));
  }, [token, router]);

  if (status === 'error') return <ErrorState />;
  if (status === 'success') return <SuccessState redirectTo={redirectTo} />;
  return <VerifyingState />;
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<VerifyingState />}>
      <VerifyContent />
    </Suspense>
  );
}
