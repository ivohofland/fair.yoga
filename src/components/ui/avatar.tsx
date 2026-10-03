import Image from 'next/image';
import { teacherPhotoPath } from '@/lib/teacher-photo-limits';
import { surfaceFill } from '@/components/ui/skeleton';

export type AvatarSize = 40 | 72;

interface AvatarProps {
  firstName: string;
  lastName: string;
  photoId: string | null;
  size: AvatarSize;
  className?: string;
}

// The frame tokens shared by every avatar shape and its skeleton, so none
// drifts apart from the others in roundness or flex behaviour.
const AVATAR_FRAME = 'shrink-0 rounded-pill';

/** First character of each name, uppercased. `Array.from` splits by code point, so an astral character stays whole. */
export function initialsOf(firstName: string, lastName: string): string {
  const first = Array.from(firstName.trim())[0] ?? '';
  const last = Array.from(lastName.trim())[0] ?? '';
  return `${first}${last}`.toUpperCase();
}

// A person, not a card: round, flat, no ring or hover step. The image's alt
// is empty and the initials are `aria-hidden` because every placement already
// names the teacher some other way, so a non-empty alt would announce it
// again (`docs/design-brief.md`, Avatar, names each placement).
export function Avatar({ firstName, lastName, photoId, size, className = '' }: AvatarProps) {
  if (photoId !== null) {
    return (
      <Image
        src={teacherPhotoPath(photoId)}
        alt=""
        width={size}
        height={size}
        unoptimized
        className={`${AVATAR_FRAME} object-cover ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`inline-flex items-center justify-center ${AVATAR_FRAME} bg-teal-tint text-teal ${
        size === 72 ? 'type-title' : 'type-subtitle'
      } ${className}`}
    >
      {initialsOf(firstName, lastName)}
    </span>
  );
}

export function AvatarSkeleton({ size }: { size: AvatarSize }) {
  return <span aria-hidden="true" style={{ width: size, height: size }} className={`inline-block ${AVATAR_FRAME} ${surfaceFill('page')}`} />;
}
