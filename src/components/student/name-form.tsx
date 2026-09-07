'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updateStudentSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface NameFormProps {
  studentId: string;
  initialFirstName: string;
  initialLastName: string;
}

type UpdateStudentWire = z.infer<typeof updateStudentSchema>;

interface NameBody {
  firstName: string;
  lastName: string;
}

/**
 * #400. Reverse pin only: `updateStudentSchema` is `.strict()`, so a key
 * this form sent that the schema had dropped would 400 at runtime, and this
 * catches it at compile time instead. No forward pin — the schema carries
 * fields this form has no business rendering.
 */
const _formHasNoExtras: NoneOf<Exclude<keyof NameBody, keyof UpdateStudentWire>> = true;
void _formHasNoExtras;

export function NameForm({
  studentId,
  initialFirstName,
  initialLastName,
}: NameFormProps) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();

    setSaving(true);
    setSaved(false);
    setError('');

    try {
      const payload: NameBody = {
        firstName: trimmedFirst,
        lastName: trimmedLast,
      };
      // Only the request itself is wrapped, so "Network error" means
      // exactly that — the success path below (state updates,
      // router.refresh()) sits outside this inner try, so a failure there
      // can't be mistaken for the save itself failing.
      let res: Response;
      try {
        res = await fetch(`/api/students/${studentId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.error('student name save failed', err);
        setError('Network error. Try again.');
        return;
      }

      if (res.ok) {
        setFirstName(trimmedFirst);
        setLastName(trimmedLast);
        setSaved(true);
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Could not save. Try again.'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="First name"
        id="firstName"
        value={firstName}
        onChange={(e) => {
          setFirstName(e.target.value);
          setError('');
          setSaved(false);
        }}
      />
      <Input
        label="Last name"
        id="lastName"
        value={lastName}
        onChange={(e) => {
          setLastName(e.target.value);
          setError('');
          setSaved(false);
        }}
      />

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          type="submit"
          disabled={saving || !firstName.trim() || !lastName.trim()}
        >
          {saving ? 'Saving...' : 'Save name'}
        </Button>
        {saved && <span className="type-caption text-teal">Saved</span>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
