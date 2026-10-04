import type { ClassStatus } from '@prisma/client';
import { formatInstantInZone } from '@/lib/timezone';
import type { TeacherSession } from '@/lib/types';

/** The outbox props the class page hands `AttendanceList`. */
export interface AttendanceOutboxProps {
  /** The signed-in account: whose outbox a tap is queued in. */
  owner: string;
  classId: string;
  /** The class as the sync block names it. */
  classLabel: string;
  /** True when this render shows the class `completed`. */
  completed: boolean;
}

interface OutboxClass {
  id: string;
  status: ClassStatus;
  calendarEntry: { classType: string };
}

/**
 * Formatted here, on the server, because the zone formatters log through the
 * server logger and must stay out of the client bundle.
 */
export function attendanceOutboxProps(
  session: TeacherSession,
  cls: OutboxClass,
  start: Date,
  timeZone: string,
): AttendanceOutboxProps {
  return {
    owner: session.accountId,
    classId: cls.id,
    classLabel: `${cls.calendarEntry.classType} on ${formatInstantInZone(start, timeZone)}`,
    completed: cls.status === 'completed',
  };
}
