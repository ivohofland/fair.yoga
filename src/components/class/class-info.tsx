import type { Class, TeacherRoom, Room } from '@prisma/client';
import { StatusBadge, deriveBadgeVariant } from '@/components/ui/status-badge';
import { RegistrationProgress } from '@/components/ui/registration-progress';
import { formatRoomLocation, formatDateWithYear } from '@/lib/format';

type ClassWithRoom = Class & {
  teacherRoom: TeacherRoom & { room: Room };
};

interface ClassInfoProps {
  cls: ClassWithRoom;
  registrationCount: number;
  waitlistCount: number;
}

// Class header block: when/where, count, status badge, and the
// registration progress bar while registrations still matter.
export function ClassInfo({ cls, registrationCount, waitlistCount }: ClassInfoProps) {
  const variant = deriveBadgeVariant(cls.status, registrationCount, cls.minStudents, cls.maxStudents);
  const showProgress = cls.status === 'open' || cls.status === 'in_progress';

  // #199, second half; corrected by the whole-branch review of #216/#182 —
  // this was the untouched twin of the identical sentence Task 9 fixed in
  // `bookings/page.tsx`, missed by that pass's keyword grep because a grep
  // scoped to one claim cannot see another claim's twin.
  //
  // Both of the following are now true, where the paragraph below used to
  // claim their opposites:
  //
  // 1. `closeQueueOnStart` (#216) DOES close a queue the moment a class
  //    leaves `open` by starting — it flips every `waiting` row to `expired`,
  //    in the same transaction as the `in_progress` write, at all three exits
  //    (`transitionClass`, `autoTransitionToInProgress`, `completeClass`'s
  //    inline bump).
  // 2. `api/registrations/route.ts`'s walk-in resolution now matches
  //    `waiting` OR `expired` (it did not before #F1), which is what makes
  //    "closes that student's entry to `claimed`" true again. Left
  //    `waiting`-only, an `in_progress` class has zero `waiting` rows by
  //    construction, so a queued student walked in at the door held a live,
  //    billed registration next to a `WaitlistEntry` stuck on `expired`
  //    forever — the exact "never got in" story `expired` exists to prevent,
  //    reintroduced from the other side of the same transaction.
  //
  // `in_progress` stays included rather than `open` alone, for the reason
  // above: during check-in a teacher may still walk a waiting — now
  // waiting-or-expired — student in. But the count fed in from
  // `class/[id]/page.tsx` must now total `waiting + expired` while
  // `in_progress`, or this reads 0 next to the very **Add walk-in** button it
  // is meant to cue (that total is computed there, not here — see its
  // comment for why `expired` cannot simply be folded into the `_count`
  // unconditionally).
  //
  // The label below switches to PAST tense on `in_progress` ("N were on the
  // waitlist") rather than repeating `open`'s "N on waitlist". #199's defect
  // was the PRESENT-tense claim about a queue that could no longer be
  // affected, not the presence of a number — so naming it as history keeps
  // the affordance (a teacher still knows to look for a walk-in) without
  // reasserting that defect. `open`'s queue is still live, so it keeps the
  // present tense.
  //
  // After `completed` nothing can consume the queue, so it stops rendering.
  // `cancelled` already reads 0 — every cancel path closes its entries to
  // `removed` (#195), never `expired` — so `completed` is the only status
  // this file still has to gate out by hand.
  //
  // Written as its own condition rather than reusing `showProgress`: the two
  // windows coincide today for the same reason (registrations still matter),
  // but they are separate decisions and a change to one must not silently
  // move the other.
  const queueIsLive = cls.status === 'open' || cls.status === 'in_progress';
  const waitlistLabel =
    cls.status === 'in_progress'
      ? `${waitlistCount} ${waitlistCount === 1 ? 'was' : 'were'} on the waitlist`
      : `${waitlistCount} on waitlist`;

  return (
    <div className="mb-6">
      <div className="mb-2">
        <StatusBadge variant={variant} />
      </div>
      <p className="type-body text-ink">
        {formatDateWithYear(cls.date)} &middot; {cls.startTime} &middot; {cls.durationMinutes} min
      </p>
      <p className="type-body">
        {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
      </p>
      <p className="type-caption mt-1">
        {registrationCount} registered &middot; needs {cls.minStudents} to go ahead
        {queueIsLive && waitlistCount > 0 && <> &middot; {waitlistLabel}</>}
      </p>
      {showProgress && (
        <RegistrationProgress
          registered={registrationCount}
          min={cls.minStudents}
          max={cls.maxStudents}
          className="mt-5"
        />
      )}
    </div>
  );
}
