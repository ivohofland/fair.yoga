'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/icon';

export interface AttendanceItem {
  registrationId: string;
  studentName: string;
  status: string;
}

interface AttendanceListProps {
  items: AttendanceItem[];
}

export function AttendanceList({ items }: AttendanceListProps) {
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
        setError(`Failed to update attendance for this student. Please try again.`);
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

          return (
            <div
              key={item.registrationId}
              className="flex items-center justify-between gap-4 min-h-16 py-2 border-b border-border last:border-b-0"
            >
              {/* Large names + big checkboxes: one-handed use at the venue */}
              <span className="text-[17px] text-ink">{item.studentName}</span>

              <div className="flex items-center gap-3">
                <span className="type-caption">
                  {isAttended ? 'Present' : 'No-show'}
                </span>
                <button
                  type="button"
                  onClick={() => toggleAttendance(item.registrationId)}
                  disabled={isUpdating}
                  className={`
                    w-11 h-11 rounded-field border-[1.5px] flex items-center justify-center
                    ${isAttended
                      ? 'bg-teal border-teal text-cream'
                      : 'bg-sand-soft border-border text-transparent'}
                    ${isUpdating ? 'opacity-50' : ''}
                  `}
                  aria-label={`Mark ${item.studentName} as ${isAttended ? 'no-show' : 'present'}`}
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
