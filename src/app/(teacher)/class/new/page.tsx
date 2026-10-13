import { requireTeacherSession } from '@/lib/session';
import { teacherCurrency } from '@/lib/teacher-currency.server';
import { teacherDefaultVatPercent } from '@/lib/teacher-vat.server';
import { NewClassForm } from './new-class-form';

export default async function NewClassPage() {
  const session = await requireTeacherSession();
  return (
    <NewClassForm
      currency={await teacherCurrency(session.teacherId)}
      defaultVatPercent={await teacherDefaultVatPercent(session.teacherId)}
    />
  );
}
