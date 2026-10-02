import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { NotificationPrefsForm } from '@/components/settings/notification-prefs-form';
import { readVapidConfig } from '@/lib/push/config';

export default async function NotificationSettingsPage() {
  const session = await requireTeacherSession();
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    select: {
      id: true,
      bookingNotifications: true,
      emailOnClassCompleted: true,
      emailOnInvitation: true,
      classReminder: true,
      classReminderChannel: true,
      pushAutoCancelled: true,
      pushBookings: true,
      pushClassCompleted: true,
      pushClassReminders: true,
      pushInvitations: true,
    },
  });
  return (
    <>
      <PageHeader title="Notifications" backHref="/settings" backLabel="Settings" />
      <NotificationPrefsForm
        teacherId={teacher.id}
        initial={{
          bookingNotifications: teacher.bookingNotifications,
          emailOnClassCompleted: teacher.emailOnClassCompleted,
          emailOnInvitation: teacher.emailOnInvitation,
          classReminder: teacher.classReminder,
          classReminderChannel: teacher.classReminderChannel,
          pushAutoCancelled: teacher.pushAutoCancelled,
          pushBookings: teacher.pushBookings,
          pushClassCompleted: teacher.pushClassCompleted,
          pushClassReminders: teacher.pushClassReminders,
          pushInvitations: teacher.pushInvitations,
        }}
        vapidPublicKey={readVapidConfig()?.publicKey ?? null}
      />
    </>
  );
}
