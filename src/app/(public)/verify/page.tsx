'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

type Status = 'verifying' | 'success' | 'error';
type StepState = 'done' | 'now' | 'pending';
type RailStep = { num: string; text: string; when: string; state: StepState };

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block w-[14px] h-[14px] mr-1"
      style={{ verticalAlign: '-2px' }}
    >
      <polyline points="4 12 10 18 20 6" />
    </svg>
  );
}

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
            className={`grid grid-cols-[28px_1fr_auto] gap-x-3 items-baseline py-[14px] border-b border-border ${
              isNow ? '-mx-2 px-2 bg-cream' : ''
            }`}
          >
            <span
              className={`font-heading italic text-[14px] text-right fy-oldstyle ${
                isPending ? 'text-fg-muted' : 'text-brown'
              }`}
            >
              {s.num}
            </span>
            <span
              className={`text-[15px] ${
                isDone
                  ? 'text-brown line-through decoration-[0.5px] decoration-brown'
                  : isPending
                    ? 'text-fg-muted'
                    : 'text-dark font-medium'
              }`}
            >
              {isDone ? <CheckIcon /> : null}
              {s.text}
            </span>
            <span
              className={`font-heading italic text-[12px] fy-oldstyle ${
                isPending ? 'text-fg-muted' : 'text-brown'
              }`}
            >
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
  const pipColor = variant === 'error' ? 'bg-error' : 'bg-teal';
  return (
    <div className="mt-[18px] font-heading italic text-[13px] text-brown leading-normal flex items-baseline gap-2 fy-oldstyle">
      <span
        className={`block w-[6px] h-[6px] flex-none ${pipColor}`}
        style={{ transform: 'translateY(-2px)' }}
      />
      <span>{children}</span>
    </div>
  );
}

function Fineprint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-6 font-heading italic text-[12px] text-brown leading-[1.55] opacity-85 fy-oldstyle">
      {children}
    </p>
  );
}

function VerifyingState() {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="fy-eyebrow mb-[10px]">One moment</p>
      <h1 className="fy-pullquote mb-4" style={{ fontSize: '35px' }}>
        Checking your link
      </h1>
      <p className="fy-lede max-w-[360px]">
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
      <p className="fy-eyebrow mb-[10px]">Welcome back</p>
      <h1 className="fy-pullquote mb-4" style={{ fontSize: '35px' }}>
        You&apos;re <span className="text-teal">signed in</span>.
      </h1>
      <p className="fy-lede max-w-[360px]">
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
        <span className="font-body not-italic font-semibold text-teal fy-oldstyle">
          {dest}
        </span>
        {' — if it doesn’t load, '}
        <Link href={dest} className="text-brown">
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
      <p className="fy-eyebrow text-error mb-[10px]">Verification failed</p>
      <h1 className="fy-pullquote mb-4" style={{ fontSize: '35px' }}>
        This link can&apos;t
        <br />
        be used.
      </h1>
      <p className="fy-lede max-w-[360px] mb-3">
        It&apos;s either past its ten-minute window, already been used, or doesn&apos;t
        match what we sent. Nothing to worry about &mdash; ask for a fresh one.
      </p>
      <ul className="list-none pl-[18px] mt-3 mb-6">
        <ErrorReason>The link is older than ten minutes</ErrorReason>
        <ErrorReason>It&apos;s already been used to sign in once</ErrorReason>
        <ErrorReason>It was opened on a device that wasn&apos;t expecting it</ErrorReason>
      </ul>
      <hr className="border-0 border-t border-border my-[22px]" />
      <div className="flex flex-col gap-[10px] mt-2">
        <Link
          href="/login"
          className="block w-full text-center bg-brown text-cream rounded-none px-6 py-[14px] min-h-[48px] font-medium text-[16px] no-underline"
        >
          Send a new link
        </Link>
        <Link
          href="/login"
          className="block w-full text-center border border-brown text-brown rounded-none px-6 py-[14px] min-h-[48px] font-medium text-[16px] no-underline"
        >
          Use a different email
        </Link>
      </div>
      <StatusLine variant="error">
        If this keeps happening, write to{' '}
        <a href="mailto:hello@fair.yoga" className="text-brown">
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
