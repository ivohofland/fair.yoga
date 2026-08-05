'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { createInvitationSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface FormErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
}

/**
 * #136. The one enumeration of this form's body. Nothing previously checked
 * it against the route's schema — since #166 that is
 * `createInvitationSchema`, which is `.strict()`, so a key this form sends
 * that the schema does not declare is a 400 rather than a silent strip. The
 * pins below are what keep the two in step.
 */
interface CreateStudentValues {
  firstName: string;
  lastName: string;
  email: string;
}

type CreateStudentWire = z.infer<typeof createInvitationSchema>;

const _formCoversCreate: NoneOf<Exclude<keyof CreateStudentWire, keyof CreateStudentValues>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof CreateStudentValues, keyof CreateStudentWire>> = true;
void _formCoversCreate;
void _formHasNoExtras;

export function CreateStudentForm() {
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /**
   * The address the last successful submit invited, or empty. Holding the
   * confirmation here rather than redirecting straight to /students is the
   * fix for the flow reading as a failure: the teacher pressed a button
   * labelled "student", landed on a page whose student directory was
   * unchanged, and had to notice a separate Contacts section further down
   * to see anything had happened at all.
   */
  const [invitedEmail, setInvitedEmail] = useState('');

  function validate(): boolean {
    const errs: FormErrors = {};
    if (!firstName.trim()) errs.firstName = 'First name is required';
    if (!email.trim()) {
      errs.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errs.email = 'Enter a valid email';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setSubmitting(true);
    setSubmitError('');

    try {
      const payload: CreateStudentValues = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
      };

      const res = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        // #166: this route no longer creates a student, it sends an
        // invitation. The fallback only shows when the server sent no
        // message of its own — the 409 refusals all carry theirs, from
        // REFUSAL_MESSAGES.
        setSubmitError(json.error?.message ?? 'Failed to send the invitation');
        return;
      }

      // #166: the id in the response body is an Invitation's, not a
      // Student's — the directory (not a detail page keyed on it) is where
      // the new contact shows up, in the Contacts section `contact-list.tsx`
      // renders there. So the body goes unread.
      setInvitedEmail(payload.email);
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function addAnother() {
    setInvitedEmail('');
    setFirstName('');
    setLastName('');
    setEmail('');
    setErrors({});
    setSubmitError('');
  }

  if (invitedEmail) {
    return (
      <section className="bg-sand-soft border border-border rounded-card p-5">
        <h2 className="type-subtitle mb-2">Invitation sent</h2>
        <p className="type-body mb-4">
          {invitedEmail} has been invited. They appear under Contacts until they accept — a
          contact joins your students once they accept, or book one of your classes.
        </p>
        <div className="flex items-center gap-3">
          <Button onClick={() => router.push('/students')}>Done</Button>
          <Button variant="secondary" onClick={addAnother}>
            Add another
          </Button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="First name"
        value={firstName}
        onChange={(e) => {
          setFirstName(e.target.value);
          setErrors((prev) => ({ ...prev, firstName: undefined }));
        }}
        error={errors.firstName}
      />
      <Input
        label="Last name"
        value={lastName}
        onChange={(e) => {
          setLastName(e.target.value);
          setErrors((prev) => ({ ...prev, lastName: undefined }));
        }}
        error={errors.lastName}
      />
      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setErrors((prev) => ({ ...prev, email: undefined }));
        }}
        error={errors.email}
      />

      {submitError && <p className="text-sm text-danger">{submitError}</p>}

      <div className="mt-4">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Sending...' : 'Send invitation'}
        </Button>
      </div>
    </form>
  );
}
