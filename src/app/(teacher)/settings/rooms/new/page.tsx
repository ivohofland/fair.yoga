import { requireTeacherSession } from '@/lib/session';
import { teacherCurrency } from '@/lib/teacher-currency.server';
import { PageHeader } from '@/components/layout/page-header';
import { AddRoomFlow } from '@/components/settings/add-room-flow';

export default async function NewRoomPage() {
  const session = await requireTeacherSession();
  const currency = await teacherCurrency(session.teacherId);
  return (
    <>
      <PageHeader title="Add room" backHref="/settings/rooms" backLabel="Rooms" />
      <AddRoomFlow currency={currency} />
    </>
  );
}
