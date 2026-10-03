import Link from 'next/link';
import type { ReactNode } from 'react';
import { Avatar, AvatarSkeleton } from '@/components/ui/avatar';
import { SkeletonText } from '@/components/ui/skeleton';

const SCHEDULE_AVATAR_SIZE = 40;

// The schedule header's frame, shared by the page and its skeleton.
function ScheduleHeaderFrame({ avatar, title, caption, action }: { avatar: ReactNode; title: ReactNode; caption: ReactNode; action: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-6" data-layout-anchor="header">
      <div className="flex items-center gap-3 min-w-0">
        {avatar}
        <div>
          {title}
          {caption}
        </div>
      </div>
      {action}
    </div>
  );
}

interface ScheduleHeaderProps {
  firstName: string;
  lastName: string;
  photoId: string | null;
  /** Already formatted for display — the page computes it. */
  today: string;
}

export function ScheduleHeader({ firstName, lastName, photoId, today }: ScheduleHeaderProps) {
  return (
    <ScheduleHeaderFrame
      avatar={
        <Link href="/settings/profile" aria-label="Profile" className="shrink-0 no-underline">
          <Avatar firstName={firstName} lastName={lastName} photoId={photoId} size={SCHEDULE_AVATAR_SIZE} />
        </Link>
      }
      title={<h1 className="type-display">Schedule</h1>}
      caption={<p className="type-caption mt-1">{today}</p>}
      action={
        <Link href="/class/new" className="type-label text-teal no-underline shrink-0">
          + Add class
        </Link>
      }
    />
  );
}

export function ScheduleHeaderSkeleton() {
  return (
    <ScheduleHeaderFrame
      avatar={
        <span className="shrink-0">
          <AvatarSkeleton size={SCHEDULE_AVATAR_SIZE} />
        </span>
      }
      title={<SkeletonText type="type-display" width="w-36" />}
      caption={<SkeletonText type="type-caption" width="w-28" className="mt-1" />}
      action={<SkeletonText type="type-label" width="w-20" className="shrink-0" />}
    />
  );
}
