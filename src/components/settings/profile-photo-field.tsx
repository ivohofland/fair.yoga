'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar } from '@/components/ui/avatar';
import { readErrorMessage } from '@/lib/client-errors';
import { ACCEPTED_PHOTO_TYPES, MAX_PHOTO_BYTES, PHOTO_MESSAGES } from '@/lib/teacher-photo-limits';

interface ProfilePhotoFieldProps {
  teacherId: string;
  firstName: string;
  lastName: string;
  photoId: string | null;
}

const UPLOAD_FALLBACK = 'Couldn’t upload that photo. Try again.';
const REMOVE_FALLBACK = 'Couldn’t remove the photo. Try again.';

// Saves on its own: the photo has its own endpoint, so it is not part of the
// profile form's Save.
export function ProfilePhotoField({ teacherId, firstName, lastName, photoId }: ProfilePhotoFieldProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/teachers/${teacherId}/photo`;

  async function send(init: RequestInit, fallback: string, state: 'uploading' | 'removing') {
    setBusy(state);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        setError(await readErrorMessage(res, fallback));
        return;
      }
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function onChoose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // choosing the same file again still fires change
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      setError(PHOTO_MESSAGES['too-large']);
      return;
    }
    const form = new FormData();
    form.append('photo', file);
    await send({ method: 'POST', body: form }, UPLOAD_FALLBACK, 'uploading');
  }

  return (
    <section className="mb-8">
      <div className="flex items-center gap-4">
        <Avatar firstName={firstName} lastName={lastName} photoId={photoId} size={72} />
        <div className="flex flex-col items-start gap-1">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_PHOTO_TYPES}
            aria-label="Profile photo"
            className="sr-only"
            onChange={onChoose}
            disabled={busy !== null}
          />
          <button
            type="button"
            className="type-label text-teal text-left"
            onClick={() => inputRef.current?.click()}
            disabled={busy !== null}
          >
            {busy === 'uploading' ? 'Uploading...' : photoId === null ? 'Upload photo' : 'Replace photo'}
          </button>
          {photoId !== null && (
            <button
              type="button"
              className="type-caption"
              onClick={() => send({ method: 'DELETE' }, REMOVE_FALLBACK, 'removing')}
              disabled={busy !== null}
            >
              {busy === 'removing' ? 'Removing...' : 'Remove'}
            </button>
          )}
        </div>
      </div>
      {error && <p role="alert" className="type-caption text-danger mt-2">{error}</p>}
    </section>
  );
}
