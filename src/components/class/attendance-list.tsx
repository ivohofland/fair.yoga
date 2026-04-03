'use client';

import { useState } from 'react';

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

  async function toggleAttendance(registrationId: string) {
    const currentStatus = attendanceState[registrationId] ?? 'registered';
    const newStatus = currentStatus === 'attended' ? 'no_show' : 'attended';

    setUpdating(registrationId);
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
      }
    } finally {
      setUpdating(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="py-6">
        <h2 className="font-heading text-lg font-bold text-dark mb-3">
          Attendance
        </h2>
        <p className="text-brown text-sm">No registered students.</p>
      </div>
    );
  }

  return (
    <div className="py-6">
      <h2 className="font-heading text-lg font-bold text-dark mb-3">
        Attendance
      </h2>

      <div>
        {items.map((item) => {
          const status = attendanceState[item.registrationId] ?? 'registered';
          const isAttended = status === 'attended';
          const isUpdating = updating === item.registrationId;

          return (
            <div
              key={item.registrationId}
              className="flex items-center justify-between py-3 border-b border-border"
            >
              <span className="text-dark text-sm">{item.studentName}</span>

              <div className="flex items-center gap-3">
                <span className="text-xs text-brown">
                  {isAttended ? 'Present' : 'No-show'}
                </span>
                <button
                  type="button"
                  onClick={() => toggleAttendance(item.registrationId)}
                  disabled={isUpdating}
                  className={`
                    w-[44px] h-[44px] rounded-lg border-2 flex items-center justify-center
                    ${isAttended
                      ? 'bg-teal border-teal text-cream'
                      : 'bg-transparent border-border text-transparent'}
                    ${isUpdating ? 'opacity-50' : ''}
                  `}
                  aria-label={`Mark ${item.studentName} as ${isAttended ? 'no-show' : 'present'}`}
                >
                  {isAttended && (
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M4 10L8 14L16 6"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
