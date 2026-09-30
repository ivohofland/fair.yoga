'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updateStudentSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { BIRTHDAY_MIN } from '@/lib/birthday';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';

interface ContactDetailsFormProps {
  studentId: string;
  initialPhone: string;
  /** `YYYY-MM-DD`, or `''` for none. */
  initialBirthday: string;
  initialAddress: string;
}

type UpdateStudentWire = z.input<typeof updateStudentSchema>;

interface ContactBody {
  phone: string;
  birthday: string;
  address: string;
}

type FieldErrors = Partial<Record<keyof ContactBody, string>>;

/** Reverse pin only, as `name-form.tsx`: a key the `.strict()` schema dropped would 400. */
const _formHasNoExtras: NoneOf<Exclude<keyof ContactBody, keyof UpdateStudentWire>> = true;
void _formHasNoExtras;

function isContactField(key: string): key is keyof ContactBody {
  return key === 'phone' || key === 'birthday' || key === 'address';
}

export function ContactDetailsForm({
  studentId,
  initialPhone,
  initialBirthday,
  initialAddress,
}: ContactDetailsFormProps) {
  const router = useRouter();
  const [phone, setPhone] = useState(initialPhone);
  const [birthday, setBirthday] = useState(initialBirthday);
  const [address, setAddress] = useState(initialAddress);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // The server bound on a birthday is UTC too.
  const todayUtcIso = new Date().toISOString().slice(0, 10);

  function touch(key: keyof ContactBody) {
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    setError('');
    setSaved(false);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    // A half-typed date reads as '' in `value`, which would silently clear the
    // stored birthday; `badInput` is the only place the browser says so.
    const birthdayInput = e.currentTarget.elements.namedItem('birthday');
    if (birthdayInput instanceof HTMLInputElement && birthdayInput.validity.badInput) {
      setFieldErrors({ birthday: 'Enter a full date, or clear the field' });
      return;
    }

    const payload: ContactBody = {
      phone: phone.trim(),
      birthday: birthday.trim(),
      address: address.trim(),
    };

    setSaving(true);
    setSaved(false);
    setError('');
    setFieldErrors({});

    try {
      // Only the request itself is wrapped, so "Network error" means exactly
      // that; the success path below sits outside this inner try.
      let res: Response;
      try {
        res = await fetch(`/api/students/${studentId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        logRequestFailure('contact-details-form', {}, err);
        setError('Network error. Try again.');
        return;
      }

      if (res.ok) {
        setPhone(payload.phone);
        setBirthday(payload.birthday);
        setAddress(payload.address);
        setSaved(true);
        // The save already succeeded; a refresh failure is a stale-page
        // problem, not a failed save, so it logs instead of raising an error.
        try {
          router.refresh();
        } catch (err) {
          console.error('student contact details save: refresh failed', err);
        }
      } else {
        const message = await readErrorMessage(res, 'Could not save. Try again.');
        const split = message.indexOf(': ');
        const field = split === -1 ? '' : message.slice(0, split);
        if (isContactField(field)) {
          setFieldErrors({ [field]: message.slice(split + 2) });
        } else {
          setError(message);
        }
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <Input
        label="Phone"
        id="phone"
        name="phone"
        type="tel"
        autoComplete="tel"
        value={phone}
        error={fieldErrors.phone}
        onChange={(e) => {
          setPhone(e.target.value);
          touch('phone');
        }}
      />
      <Input
        label="Birthday"
        id="birthday"
        name="birthday"
        type="date"
        min={BIRTHDAY_MIN}
        max={todayUtcIso}
        hint="Share it per teacher under Privacy — as your birthday (day and month), your age, or both."
        value={birthday}
        error={fieldErrors.birthday}
        onChange={(e) => {
          setBirthday(e.target.value);
          touch('birthday');
        }}
      />
      <Textarea
        label="Address"
        id="address"
        name="address"
        autoComplete="street-address"
        rows={3}
        value={address}
        error={fieldErrors.address}
        onChange={(e) => {
          setAddress(e.target.value);
          touch('address');
        }}
      />

      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? 'Saving...' : 'Save contact details'}
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
