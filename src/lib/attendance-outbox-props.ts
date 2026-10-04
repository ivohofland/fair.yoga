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
  /** Server epoch ms of this render. */
  renderedAt: number;
}

interface OutboxClass {
  id: string;
  status: ClassStatus;
  calendarEntry: { classType: string };
}

/** Built on the server; `renderedAt` is the page's own render instant. */
export function attendanceOutboxProps(
  session: TeacherSession,
  cls: OutboxClass,
  start: Date,
  timeZone: string,
  renderedAt: number,
): AttendanceOutboxProps {
  return {
    owner: session.accountId,
    classId: cls.id,
    classLabel: `${cls.calendarEntry.classType} on ${formatInstantInZone(start, timeZone)}`,
    completed: cls.status === 'completed',
    renderedAt,
  };
}
