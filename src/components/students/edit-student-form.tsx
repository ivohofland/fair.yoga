'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { createStudentSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface EditStudentFormProps {
  studentId: string;
  initialFirstName: string;
  initialLastName: string;
  initialEmail: string;
}

type CreateStudentWire = z.infer<typeof createStudentSchema>;
type EditStudentBody = { firstName: string; lastName: string; email: string };

/**
 * #136. Pinned against `createStudentSchema`, not `updateStudentSchema`,
 * which is not the obvious choice: `PUT /api/students/[id]` picks its schema
 * by *caller identity*, not by method. `session.studentId === id` (a student
 * editing themselves) parses with `updateStudentSchema`; every other caller —
 * including this teacher-facing CRM form — parses with `createStudentSchema`.
 * See `src/app/api/students/[id]/route.ts`, the two `parseBody` calls in `PUT`.
 *
 * Both directions apply here because this form owns its branch's schema
 * outright: three keys, three inputs.
 *
 * `createStudentSchema` is not `.strict()`, unlike `updateStudentSchema` —
 * which the sibling student forms post to. So an extra key sent here would
 * not 400; Zod would silently strip it, and the field would vanish without a
 * word. That is the exact failure mode #136 exists to eliminate, which makes
 * this reverse pin worth more on this form than on the strict ones, not less.
 */
const _formCoversSchema: NoneOf<Exclude<keyof CreateStudentWire, keyof EditStudentBody>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof EditStudentBody, keyof CreateStudentWire>> = true;
void _formCoversSchema;
void _formHasNoExtras;

export function EditStudentForm({
  studentId,
  initialFirstName,
  initialLastName,
  initialEmail,
}: EditStudentFormProps) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName.trim() || !email.trim()) {
      setError('First name and email are required');
      return;
    }
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch(`/api/students/${studentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
        }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to update student');
        return;
      }

      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="First name"
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
      />
      <Input
        label="Last name"
        value={lastName}
        onChange={(e) => setLastName(e.target.value)}
      />
      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="mt-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
