'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/icon';
import {
  dismissRefused,
  enqueueAttendance,
  getOutbox,
  shownStatus,
  useOutbox,
  type QueuedStatus,
} from '@/lib/attendance-outbox';
import { flushAttendance } from '@/lib/attendance-sync';
import { logRequestFailure } from '@/lib/client-errors';
import {
  refusalLine,
  useAttendanceOwner,
  useInlineRefusals,
} from '@/components/layout/attendance-sync-status';
import type { AttendanceStatus } from '@/lib/registration-status';

export type { AttendanceStatus };

export interface AttendanceItem {
  registrationId: string;
  studentName: string;
  status: AttendanceStatus;
}

export interface AttendanceListProps {
  items: AttendanceItem[];
  classId: string;
  /** The page's server clock at render, epoch ms; a confirmation older than this yields to `items`. */
  renderedAt: number;
  /** True on a completed class: rows render read-only until the teacher opts
   *  into "Edit attendance". Defaults to `false` (check-in behaviour, always
   *  editable). */
  locked?: boolean;
}

/**
 * A row's label, tethered to the compiler against `AttendanceStatus` so a
 * future member fails here rather than falling through to a wrong label.
 * `registered` reads "Not marked" rather than "No-show" — an untouched row is
 * not a recorded absence, and must not read as one (spec D5; #234).
 */
function statusLabel(status: AttendanceStatus): string {
  switch (status) {
    case 'attended':
      return 'Present';
    case 'late_cancel':
      return 'Late cancel';
    case 'no_show':
      return 'No-show';
    case 'registered':
      return 'Not marked';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * No class-status prop, deliberately. The server refuses
 * `late_cancel -> attended` while the class is still `open` (see the WHERE in
 * `api/registrations/[id]/route.ts`), and disabling the control until then
 * looks like the obvious move. But this page is a server component with no
 * `revalidate`, check-in renders from T-15min, and `autoTransitionToInProgress`
 * flips the class up to 60s after the start, so any class-status prop is frozen
 * at render: a teacher who opened the page before the class began would hold a
 * permanently disabled control for the whole class — a silent refusal in place
 * of a visible one.
 *
 * The server is the only thing that knows, so it decides and says why. A tap is
 * queued in the attendance outbox and a flush sends it, online or offline alike
 * (spec D1); a row shows what is queued, else what a flush confirmed after this
 * render, else `items`. A refusal for this class shows here in the server's
 * words and refreshes the page, so the next tap is judged against what is now
 * true. A success does not refresh.
 */
export function AttendanceList({ items, classId, renderedAt, locked = false }: AttendanceListProps) {
  const router = useRouter();
  const ownerId = useAttendanceOwner();
  const outbox = useOutbox();
  // `locked` only sets where this starts — check-in opens editable, a
  // completed class opens read-only until the teacher's own "Edit
  // attendance" tap unlocks the row controls.
  const [editing, setEditing] = useState(!locked);
  useInlineRefusals(classId);

  // Refusal ids already on the device at mount. Seeded from the live store, not
  // `outbox`: while hydrating, `outbox` is the empty server snapshot, and every
  // stored refusal would then look new and refresh on every reload.
  const seenRefusals = useRef<Set<string> | null>(null);
  useEffect(() => {
    seenRefusals.current = new Set(Object.values(getOutbox().refused).map((e) => e.id));
  }, []);

  useEffect(() => {
    const seen = seenRefusals.current;
    if (seen === null) return;
    let arrived = false;
    for (const e of Object.values(outbox.refused)) {
      if (e.classId === classId && !seen.has(e.id)) {
        seen.add(e.id);
        arrived = true;
      }
    }
    // The refusal may be about state this page no longer reflects — it is
    // server-rendered with no revalidation, so a class that started after the
    // render still reads `open` here. Re-render so the next tap is judged
    // against what is actually true.
    if (arrived) router.refresh();
  }, [outbox, classId, router]);

  async function toggleAttendance(owner: string, item: AttendanceItem) {
    // The live store, not this render's `outbox`: a second tap can land before
    // the first tap's write has re-rendered the row.
    const currentStatus = shownStatus(getOutbox(), item.registrationId, item.status, renderedAt).status;
    // A student who cancelled late is not a no-show — they told the teacher they
    // were not coming, and were charged for saying so. The only correction that
    // means anything for them is "they came after all", and it has to be
    // reversible: a plain attended/no_show toggle would destroy `late_cancel` on
    // the second tap with no way back, taking with it the caption their own
    // `/bookings` page shows them ("Cancelled after the deadline — this class is
    // still charged"). `updateRegistrationSchema` accepts `late_cancel`, so the
    // round trip is expressible.
    const newStatus: QueuedStatus =
      item.status === 'late_cancel'
        ? currentStatus === 'attended'
          ? 'late_cancel'
          : 'attended'
        : currentStatus === 'attended'
          ? 'no_show'
          : 'attended';

    await enqueueAttendance({
      ownerId: owner,
      registrationId: item.registrationId,
      classId,
      studentName: item.studentName,
      status: newStatus,
    });
    void flushAttendance(owner);
  }

  const waiting = Object.values(outbox.pending).filter((e) => e.classId === classId).length;
  const refused = Object.values(outbox.refused).filter((e) => e.classId === classId);

  const heading = (
    <div className="flex items-baseline justify-between gap-4 mb-3">
      <h2 className="type-subtitle">Attendance</h2>
      {waiting > 0 && <p className="type-caption">{waiting} waiting to sync</p>}
    </div>
  );

  const refusals = refused.map((entry) => {
    const line = refusalLine(entry);
    return (
      <div key={entry.registrationId} className="flex flex-wrap items-baseline gap-x-3 mt-3">
        <p role="alert" className="type-caption text-danger">
          {line}
        </p>
        <button
          type="button"
          aria-label={`Dismiss: ${line}`}
          className="type-caption underline"
          onClick={() => void dismissRefused(entry.registrationId)}
        >
          Dismiss
        </button>
      </div>
    );
  });

  if (items.length === 0) {
    return (
      <div className="py-6">
        {heading}
        <p className="type-body">No registered students.</p>
        {refusals}
      </div>
    );
  }

  return (
    <div className="py-6">
      {heading}

      {!editing && (
        <button type="button" onClick={() => setEditing(true)} className="type-label text-teal mb-3">
          Edit attendance
        </button>
      )}

      {editing && locked && (
        <p className="type-caption mb-3">
          Corrections update the record — the payment request already sent stays as it is.
        </p>
      )}

      <div>
        {items.map((item) => {
          const shown = shownStatus(outbox, item.registrationId, item.status, renderedAt);
          const isAttended = shown.status === 'attended';

          return (
            <div
              key={item.registrationId}
              className="flex items-center justify-between gap-4 min-h-16 py-2 border-b border-border last:border-b-0"
            >
              {/* Large names + big checkboxes: one-handed use at the venue */}
              <span className="text-[17px] text-ink">{item.studentName}</span>

              <div className="flex items-center gap-3">
                <span className="type-caption">
                  {shown.pending ? 'Waiting to sync' : statusLabel(shown.status)}
                </span>
                {/* No owner means no teacher layout, and the teacher layout always provides one. */}
                {editing && ownerId !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      toggleAttendance(ownerId, item).catch((err: unknown) =>
                        logRequestFailure('attendance-list', { registrationId: item.registrationId }, err),
                      );
                    }}
                    className={`
                      w-11 h-11 rounded-field border-[1.5px] flex items-center justify-center
                      ${isAttended
                        ? 'bg-teal border-teal text-cream'
                        : 'bg-sand-soft border-border text-transparent'}
                      disabled:opacity-50 disabled:cursor-not-allowed
                    `}
                    aria-label={
                      item.status === 'late_cancel'
                        ? `${item.studentName} cancelled late — mark them ${isAttended ? 'cancelled again' : 'present'}`
                        : `Mark ${item.studentName} as ${isAttended ? 'no-show' : 'present'}`
                    }
                  >
                    {isAttended && <Icon name="check" size={22} />}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {refusals}
    </div>
  );
}
