import Link from 'next/link';
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

function formatName(firstName: string, lastName: string): string {
  const lastInitial = lastName.length > 0 ? lastName[0] : '';
  return `${firstName} ${lastInitial ? lastInitial.toLowerCase() + '.' : ''}`.trim();
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
    return <p className="text-brown text-sm">No students yet.</p>;
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
            className="flex items-center justify-between py-3 border-b border-border"
          >
            <div className="flex flex-col gap-1">
              <span className="text-dark text-sm font-medium">
                {formatName(student.firstName, student.lastName)}
              </span>
              <span className="text-brown text-xs">
                Last class: {lastClassDate}
              </span>
            </div>
            <span className="text-brown text-sm">
              {student._count.registrations} {student._count.registrations === 1 ? 'class' : 'classes'}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
