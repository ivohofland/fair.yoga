'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { readErrorMessage } from '@/lib/client-errors';

export interface AttendanceItem {
  registrationId: string;
  studentName: string;
  status: string;
}

interface AttendanceListProps {
  items: AttendanceItem[];
  /**
   * Whether the class is still `open` — i.e. this is the 15-minute pre-start
   * check-in window rather than the class itself.
   *
   * A late-cancelled student who turns up anyway can be marked present, but only
   * once the class has STARTED: while it is `open`, moving them into the counted
   * set can race `autoCancelClasses` into cancelling a class that had enough
   * students (see the WHERE in `api/registrations/[id]/route.ts`). Their row is
   * shown either way — the teacher needs to see who is expected — but the
   * control is inert until the refusal window has passed, because offering a
   * button that is guaranteed to 409 is worse than not offering it.
   */
  classIsOpen: boolean;
}

export function AttendanceList({ items, classIsOpen }: AttendanceListProps) {
  const [attendanceState, setAttendanceState] = useState<
    Record<string, string>
  >(
    Object.fromEntries(items.map((item) => [item.registrationId, item.status])),
  );
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggleAttendance(registrationId: string) {
    const currentStatus = attendanceState[registrationId] ?? 'registered';
    const newStatus = currentStatus === 'attended' ? 'no_show' : 'attended';

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
          const lockedUntilStart = status === 'late_cancel' && classIsOpen;
          // A late cancel is neither present nor a no-show, and labelling it
          // "No-show" is what made the inert control look worth tapping.
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
                  onClick={() => toggleAttendance(item.registrationId)}
                  disabled={isUpdating || lockedUntilStart}
                  title={
                    lockedUntilStart
                      ? 'Can be marked present once the class has started'
                      : undefined
                  }
                  className={`
                    w-11 h-11 rounded-field border-[1.5px] flex items-center justify-center
                    ${isAttended
                      ? 'bg-teal border-teal text-cream'
                      : 'bg-sand-soft border-border text-transparent'}
                    ${isUpdating || lockedUntilStart ? 'opacity-50' : ''}
                  `}
                  aria-label={
                    lockedUntilStart
                      ? `${item.studentName} cancelled late — can be marked present once the class has started`
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
