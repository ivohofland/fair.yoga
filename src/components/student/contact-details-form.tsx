'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updateStudentSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { BIRTHDAY_MIN } from '@/lib/birthday';
import {
  ADDRESS_MAX,
  CONTACT_FIELDS,
  PHONE_MAX,
  isContactField,
  parseFieldErrors,
  type ContactField,
  type FieldErrors,
} from '@/lib/contact-details';
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

type ContactBody = Record<ContactField, string>;

/** Reverse pin only, as `name-form.tsx`: a key the `.strict()` schema dropped would 400. */
const _formHasNoExtras: NoneOf<Exclude<keyof ContactBody, keyof UpdateStudentWire>> = true;
void _formHasNoExtras;

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

  // UTC, as `parseBirthday` bounds it.
  const todayUtcIso = new Date().toISOString().slice(0, 10);

  // Fields changed since the request in flight was sent: its answer is about
  // values they no longer hold.
  const editedInFlight = useRef(new Set<ContactField>());

  function touch(key: ContactField) {
    editedInFlight.current.add(key);
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    setError('');
    setSaved(false);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    // A half-typed date reads as '' in `value`, which would silently clear the
    // stored birthday; `badInput` is the only place the browser says so.
    const form = e.currentTarget;
    const birthdayInput = form.elements.namedItem('birthday');
    if (birthdayInput instanceof HTMLInputElement && birthdayInput.validity.badInput) {
      setError('');
      setSaved(false);
      setFieldErrors({ birthday: 'Enter a full date, or clear the field' });
      // `noValidate` withholds the browser's own move to the first invalid
      // field, so a keyboard user who pressed Enter is put there here.
      birthdayInput.focus();
      return;
    }

    const payload: ContactBody = {
      phone: phone.trim(),
      birthday: birthday.trim(),
      address: address.trim(),
    };

    editedInFlight.current.clear();
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

      const edited = editedInFlight.current;
      if (res.ok) {
        // Writing the trimmed payload back over an edit would discard it, and
        // "Saved" would then vouch for text the server never received.
        if (edited.size === 0) {
          setPhone(payload.phone);
          setBirthday(payload.birthday);
          setAddress(payload.address);
          setSaved(true);
        }
        // The save already succeeded; a refresh failure is a stale-page
        // problem, not a failed save, so it logs instead of raising an error.
        try {
          router.refresh();
        } catch (err) {
          console.error('student contact details save: refresh failed', err);
        }
      } else {
        const message = await readErrorMessage(res, 'Could not save. Try again.');
        const found = parseFieldErrors(message);
        if (Object.keys(found).length === 0) {
          setError(message);
        } else {
          const current: FieldErrors = {};
          for (const key of CONTACT_FIELDS) {
            if (!edited.has(key) && found[key] !== undefined) current[key] = found[key];
          }
          setFieldErrors(current);
          const first = Object.keys(found).filter(isContactField).find((k) => !edited.has(k));
          const invalid = first ? form.elements.namedItem(first) : null;
          if (invalid instanceof HTMLElement) invalid.focus();
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
        maxLength={PHONE_MAX}
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
        maxLength={ADDRESS_MAX}
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
