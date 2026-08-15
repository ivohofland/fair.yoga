'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/icon';
import { readErrorMessage } from '@/lib/client-errors';

export interface AttendanceItem {
  registrationId: string;
  studentName: string;
  status: string;
}

interface AttendanceListProps {
  items: AttendanceItem[];
}

/**
 * No `classIsOpen` prop, deliberately — an earlier version had one and it could
 * not work.
 *
 * The server refuses `late_cancel -> attended` while the class is still `open`
 * (see the WHERE in `api/registrations/[id]/route.ts`), and the obvious move is
 * to disable the control until then. But this page is a server component with
 * no `revalidate`, and check-in renders from T-15min, while
 * `autoTransitionToInProgress` flips the class up to 60s after the start. Any
 * class-status prop is therefore frozen at render: a teacher who opened the page
 * before the class began would hold a permanently disabled control, under a
 * tooltip saying "once the class has started", for the whole class. That trades
 * a visible refusal for a silent one, which is worse.
 *
 * The server is the only thing that knows, so it decides and says why, and a
 * refusal refreshes the page so the next tap is judged against what is now true.
 */
export function AttendanceList({ items }: AttendanceListProps) {
  const router = useRouter();
  const [attendanceState, setAttendanceState] = useState<
    Record<string, string>
  >(
    Object.fromEntries(items.map((item) => [item.registrationId, item.status])),
  );
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggleAttendance(registrationId: string, originalStatus: string) {
    const currentStatus = attendanceState[registrationId] ?? 'registered';
    // A student who cancelled late is not a no-show — they told the teacher they
    // were not coming, and were charged for saying so. The only correction that
    // means anything for them is "they came after all", and it has to be
    // reversible: a plain attended/no_show toggle would destroy `late_cancel` on
    // the second tap with no way back, taking with it the caption their own
    // `/bookings` page shows them ("Cancelled after the deadline — this class is
    // still charged"). `updateRegistrationSchema` accepts `late_cancel`, so the
    // round trip is expressible.
    const newStatus =
      originalStatus === 'late_cancel'
        ? currentStatus === 'attended'
          ? 'late_cancel'
          : 'attended'
        : currentStatus === 'attended'
          ? 'no_show'
          : 'attended';

    setUpdating(registrationId);
    setError(null);
    try {
      const response = await fetch(`/api/registrations/${registrationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      if (response.ok) {
        setAttendanceState((prev) => ({
          ...prev,
          [registrationId]: newStatus,
        }));
      } else {
        // The server's own words, not a generic retry prompt: every refusal this
        // endpoint issues is permanent for the request as sent, so "try again"
        // is advice that cannot work.
        setError(await readErrorMessage(response, 'Could not update attendance.'));
        // The refusal may be about state this page no longer reflects — it is
        // server-rendered with no revalidation, so a class that started after
        // the render still reads `open` here. Re-render so the next tap is
        // judged against what is actually true.
        router.refresh();
      }
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setUpdating(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="py-6">
        <h2 className="type-subtitle mb-3">Attendance</h2>
        <p className="type-body">No registered students.</p>
      </div>
    );
  }

  return (
    <div className="py-6">
      <h2 className="type-subtitle mb-3">Attendance</h2>

      {error && (
        <p role="alert" className="text-danger text-sm mb-3">
          {error}
        </p>
      )}

      <div>
        {items.map((item) => {
          const status = attendanceState[item.registrationId] ?? 'registered';
          const isAttended = status === 'attended';
          const isUpdating = updating === item.registrationId;
          // Shown, but not yet actionable — see `classIsOpen`. Once the class
          // starts this goes false and the row behaves like any other.
          // A late cancel is neither present nor a no-show. Labelling it
          // "No-show" said the opposite of what happened, and is what made the
          // row look like an untouched one worth tapping.
          const statusLabel = isAttended
            ? 'Present'
            : status === 'late_cancel'
              ? 'Late cancel'
              : 'No-show';

          return (
            <div
              key={item.registrationId}
              className="flex items-center justify-between gap-4 min-h-16 py-2 border-b border-border last:border-b-0"
            >
              {/* Large names + big checkboxes: one-handed use at the venue */}
              <span className="text-[17px] text-ink">{item.studentName}</span>

              <div className="flex items-center gap-3">
                <span className="type-caption">{statusLabel}</span>
                <button
                  type="button"
                  onClick={() => toggleAttendance(item.registrationId, item.status)}
                  disabled={isUpdating}
                  className={`
                    w-11 h-11 rounded-field border-[1.5px] flex items-center justify-center
                    ${isAttended
                      ? 'bg-teal border-teal text-cream'
                      : 'bg-sand-soft border-border text-transparent'}
                    ${isUpdating ? 'opacity-50' : ''}
                  `}
                  aria-label={
                    item.status === 'late_cancel'
                      ? `${item.studentName} cancelled late — mark them ${isAttended ? 'cancelled again' : 'present'}`
                      : `Mark ${item.studentName} as ${isAttended ? 'no-show' : 'present'}`
                  }
                >
                  {isAttended && <Icon name="check" size={22} />}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
