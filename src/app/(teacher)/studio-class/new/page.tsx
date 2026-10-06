import { requireTeacherSession } from '@/lib/session';
import { teacherCurrency } from '@/lib/teacher-currency.server';
import { NewStudioClassForm } from './new-studio-class-form';

export default async function NewStudioClassPage() {
  const session = await requireTeacherSession();
  return <NewStudioClassForm currency={await teacherCurrency(session.teacherId)} />;
}
