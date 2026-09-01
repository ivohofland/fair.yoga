'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PageAddressField, slugFromName } from './page-address-field';

const BIO_MAX = 250;

/**
 * Where a half-typed profile waits out a re-issued ticket.
 *
 * `localStorage`, not `sessionStorage`: the fresh link arrives by email and is
 * usually opened in a NEW TAB, which gets its own session store and would
 * therefore find nothing. Same browser, same draft — a different device starts
 * clean, which is the accepted cost of not persisting a half-typed profile
 * server-side.
 *
 * Cleared as soon as this page can no longer submit it — created, or refused
 * for good — so a shared browser does not keep someone's name and bio after
 * they are done here.
 */
const DRAFT_KEY = 'fair_yoga_profile_draft';

/** Both terminal outcomes end here. A store that was never writable has
 *  nothing to clean up, so a throw is as good as a success. */
function forgetDraft(): void {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing stored, nothing to remove.
  }
}

/** Every field the form owns, and the one flag that says how to treat them. */
interface Draft {
  firstName: string;
  lastName: string;
  bio: string;
  pageSlug: string;
  /** True once the teacher edits the address themselves — from then on it
   *  stops following the two name fields. */
  slugEdited: boolean;
}

const EMPTY_DRAFT: Draft = {
  firstName: '',
  lastName: '',
  bio: '',
  pageSlug: '',
  slugEdited: false,
};

/** Nothing read back out of a browser store is trusted to still be a `Draft`. */
function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.firstName === 'string' &&
    typeof d.lastName === 'string' &&
    typeof d.bio === 'string' &&
    typeof d.pageSlug === 'string' &&
    typeof d.slugEdited === 'boolean'
  );
}

/**
 * The device's zone, or nothing (#258).
 *
 * Called from the submit handler, never from render. A `'use client'`
 * component still server-renders, and React 19 keeps that server value through
 * hydration — so a zone read during render is the SERVER's zone, which under
 * the Dockerfile's absent `TZ` is UTC: not the teacher's, not the device's,
 * nobody's. That is worse than the Amsterdam fallback the route applies when
 * this returns nothing, because it looks like it worked. Same trap
 * `src/lib/use-today-local.ts` documents at length for the date pickers.
 */
function detectTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `expired` and `expired-stuck` are the same event told honestly two ways: the
 * ticket aged out mid-typing, and the replacement link either went out or did
 * not. Saying "we've emailed you a fresh link" when that request failed is
 * worse than saying nothing.
 */
type Status = 'idle' | 'submitting' | 'expired' | 'expired-stuck' | 'already-teacher';

interface ProfileSetupFormProps {
  /** The address behind the live signup ticket. Display and re-send only —
   *  the route takes the email from the ticket it consumes, never from us. */
  email: string;
}

/**
 * Step two of teacher signup (#385): the profile the ticket authorises.
 *
 * The ticket lives an hour and this form is four fields, so it can still age
 * out under someone's hands. A 401 at submit is therefore a recoverable state
 * and not an error — every value stays exactly where it was, and a fresh link
 * goes out on its own.
 */
export function ProfileSetupForm({ email }: ProfileSetupFormProps) {
  const [form, setForm] = useState<Draft>(EMPTY_DRAFT);
  const [status, setStatus] = useState<Status>('idle');
  const [slugError, setSlugError] = useState('');
  const [formError, setFormError] = useState('');

  /**
   * The draft is restored once, on mount, and only here.
   *
   * Not a lazy `useState` initializer: there is no `localStorage` during the
   * server render, so the two passes would disagree and React 19 keeps the
   * SERVER's value through hydration — the draft would be read and then
   * thrown away. An effect is the only pass that runs on the client alone.
   */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      const draft: unknown = raw === null ? null : JSON.parse(raw);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount read of a browser store, for the reason in the docblock above; it cannot cascade, the effect has no dependencies.
      if (isDraft(draft)) setForm(draft);
    } catch {
      // A corrupt entry, or a browser that refuses the store outright. Both
      // mean the same thing here: no draft, start clean.
    }
  }, []);

  /**
   * Every change goes through here, so persisting is part of changing rather
   * than an effect chasing it. An effect would have to be gated on "has the
   * restore run yet", since its own mount pass would otherwise write the
   * empty initial state over the draft it is about to read.
   */
  function apply(next: Draft) {
    setForm(next);
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    } catch {
      // Persisting is a courtesy, never a precondition for submitting.
    }
  }

  function updateNames(firstName: string, lastName: string) {
    apply({
      ...form,
      firstName,
      lastName,
      pageSlug: form.slugEdited ? form.pageSlug : slugFromName(firstName, lastName),
    });
  }

  // Clearing the field hands it back to the names, so a derived address is
  // never something the teacher is stuck with in either direction.
  function updateSlug(pageSlug: string) {
    setSlugError('');
    apply({ ...form, pageSlug, slugEdited: pageSlug !== '' });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    setSlugError('');
    setFormError('');

    const timeZone = detectTimeZone();

    let res: Response;
    try {
      res = await fetch('/api/account/teacher-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          bio: form.bio.trim(),
          pageSlug: form.pageSlug.trim(),
          // Omitted rather than sent empty: the schema is `.strict()`, and the
          // route's own Amsterdam fallback covers a browser that cannot report
          // a zone.
          ...(timeZone ? { defaultTimezone: timeZone } : {}),
        }),
      });
    } catch {
      setStatus('idle');
      setFormError('Network error. Please try again.');
      return;
    }

    if (res.ok) {
      forgetDraft();
      // A hard navigation, not `router.push`: this response set the session
      // cookie, and every layout above /schedule renders differently now than
      // in any payload the client router cached while signed out. `status`
      // stays 'submitting' so the button does not go idle under a navigation
      // that is already in flight.
      window.location.assign('/schedule');
      return;
    }

    const body: { error?: { code?: string; message?: string } } = await res
      .json()
      .catch(() => ({}));

    // The ticket aged out while they were typing. Not an error — a re-send,
    // with every field left exactly where it is.
    if (res.status === 401) {
      const resent = await fetch('/api/auth/teacher-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
        .then((r) => r.ok)
        .catch(() => false);
      setStatus(resent ? 'expired' : 'expired-stuck');
      return;
    }

    // Terminal: this address already has a page, so nothing typed here will
    // ever be submitted from this form.
    if (body.error?.code === 'ALREADY_TEACHER') {
      forgetDraft();
      setStatus('already-teacher');
      return;
    }

    setStatus('idle');
    if (body.error?.code === 'SLUG_TAKEN') {
      // The route already replaced the ticket it spent on this request, so the
      // retry this message asks for is a plain resubmit.
      setSlugError('That address is taken — please pick another.');
    } else {
      setFormError(body.error?.message ?? 'Something went wrong. Please try again.');
    }
  }

  if (status === 'already-teacher') {
    return (
      <div className="py-4">
        <p className="type-subtitle">You already teach here</p>
        <p className="type-body mt-2 max-w-[420px]">
          There is already a teacher page for {email}.{' '}
          <Link href="/login" className="text-teal">
            Sign in
          </Link>{' '}
          and you are back where you left off.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="type-display mb-5">Set up your teacher page</h1>
      <p className="type-body max-w-[420px] mb-8">
        You&apos;re signing up as <span className="text-ink">{email}</span>. Your
        name and a page address are all we need &mdash; the bio can wait.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          label="First name"
          value={form.firstName}
          onChange={(e) => updateNames(e.target.value, form.lastName)}
          required
        />
        <Input
          label="Last name"
          value={form.lastName}
          onChange={(e) => updateNames(form.firstName, e.target.value)}
          required
        />

        <PageAddressField
          value={form.pageSlug}
          onChange={updateSlug}
          error={slugError || undefined}
        />

        <div className="flex flex-col gap-2">
          <Textarea
            label="Bio"
            value={form.bio}
            onChange={(e) => apply({ ...form, bio: e.target.value })}
            maxLength={BIO_MAX}
            rows={3}
          />
          <div className="flex items-baseline justify-between gap-3">
            <span className="type-caption">Optional &mdash; you can add this later.</span>
            <span className="type-caption">
              {form.bio.length}/{BIO_MAX}
            </span>
          </div>
        </div>

        <Button type="submit" disabled={status === 'submitting'} className="w-full">
          {status === 'submitting' ? 'Setting up...' : 'Create my page'}
        </Button>

        {status === 'expired' && (
          <p role="status" className="type-caption">
            That took a while &mdash; we&apos;ve emailed you a fresh link.
            Your details are still here.
          </p>
        )}
        {status === 'expired-stuck' && (
          <p role="status" className="type-caption">
            That took a while and the link expired &mdash; and we couldn&apos;t
            send a fresh one just now. Your details are still here; try again in
            a moment.
          </p>
        )}
        {formError && (
          <p role="alert" className="text-[13px] leading-[1.4] text-danger">
            {formError}
          </p>
        )}
      </form>
    </div>
  );
}
