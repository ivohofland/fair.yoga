import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { Accordion } from '@/components/layout/accordion';
import { ClassList } from '@/components/schedule/class-list';
import { StudentList } from '@/components/students/student-list';
import { InboxSection } from '@/components/layout/inbox-section';
import { SettingsSection } from '@/components/layout/settings-section';

export default async function TeacherHome() {
  const session = await requireTeacherSession();

  const [classes, students, notifications, teacher] = await Promise.all([
    prisma.class.findMany({
      where: { teacherId: session.userId },
      orderBy: { date: 'asc' },
      include: {
        _count: { select: { registrations: true } },
        teacherRoom: { include: { room: true } },
      },
    }),
    prisma.student.findMany({
      where: {
        registrations: {
          some: { class: { teacherId: session.userId } },
        },
      },
      include: {
        registrations: {
          where: { class: { teacherId: session.userId } },
          orderBy: { registeredAt: 'desc' },
          take: 1,
          include: { class: { select: { date: true, classType: true } } },
        },
        _count: {
          select: {
            registrations: {
              where: { class: { teacherId: session.userId } },
            },
          },
        },
      },
    }),
    prisma.notification.findMany({
      where: {
        recipientType: 'teacher',
        recipientId: session.userId,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.teacher.findUniqueOrThrow({
      where: { id: session.userId },
      include: {
        _count: { select: { teacherRooms: true } },
      },
    }),
  ]);

  return (
    <Accordion
      defaultOpen="schedule"
      sections={[
        {
          id: 'schedule',
          label: 'Schedule',
          children: <ClassList classes={classes} />,
        },
        {
          id: 'students',
          label: 'Students',
          children: <StudentList students={students} />,
        },
        {
          id: 'inbox',
          label: 'Inbox',
          children: <InboxSection notifications={notifications} />,
        },
        {
          id: 'settings',
          label: 'Settings',
          children: <SettingsSection teacher={teacher} />,
        },
      ]}
    />
  );
}
