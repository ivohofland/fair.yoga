import Link from 'next/link';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import { formatStudentName } from '@/lib/format';
import type { Student, Registration, Class } from '@prisma/client';

type StudentWithDetails = Student & {
  registrations: (Registration & {
    class: Pick<Class, 'date' | 'classType'>;
  })[];
  _count: { registrations: number };
};

interface StudentListProps {
  students: StudentWithDetails[];
}


function formatDate(date: Date): string {
  const d = new Date(date);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const monthName = months[d.getUTCMonth()];
  const dayNum = d.getUTCDate();
  return `${monthName} ${dayNum}`;
}

export function StudentList({ students }: StudentListProps) {
  if (students.length === 0) {
    return <EmptyState title="No students yet." />;
  }

  const sorted = [...students].sort((a, b) =>
    a.firstName.localeCompare(b.firstName),
  );

  return (
    <div>
      {sorted.map((student) => {
        const latestReg = student.registrations[0];
        const lastClassDate = latestReg
          ? formatDate(latestReg.class.date)
          : 'No classes';

        return (
          <Link
            key={student.id}
            href={`/students/${student.id}`}
            className="flex items-center gap-3 min-h-14 py-2 border-b border-border last:border-b-0 no-underline"
          >
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <span className="text-base text-ink font-medium">
                {formatStudentName(student.firstName, student.lastName)}
              </span>
              <span className="type-caption">
                Last class: {lastClassDate}
              </span>
            </div>
            <span className="type-caption">
              {student._count.registrations} {student._count.registrations === 1 ? 'class' : 'classes'}
            </span>
            <Icon name="chevron-right" size={20} className="text-brown-light" />
          </Link>
        );
      })}
    </div>
  );
}
