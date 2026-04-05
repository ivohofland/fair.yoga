'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface FormErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
}

export function CreateStudentForm() {
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const errs: FormErrors = {};
    if (!firstName.trim()) errs.firstName = 'First name is required';
    if (!lastName.trim()) errs.lastName = 'Last name is required';
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
      const res = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setSubmitError(json.error?.message ?? 'Failed to create student');
        return;
      }

      const json: { data: { id: string } } = await res.json();
      router.push(`/students/${json.data.id}`);
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
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

      {submitError && <p className="text-sm text-error">{submitError}</p>}

      <div className="mt-4">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Adding...' : 'Add student'}
        </Button>
      </div>
    </form>
  );
}
