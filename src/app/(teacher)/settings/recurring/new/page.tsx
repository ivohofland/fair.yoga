import { requireTeacherSession } from '@/lib/session';
import { teacherCurrency } from '@/lib/teacher-currency.server';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateForm } from '@/components/settings/template-form';

export default async function NewTemplatePage() {
  const session = await requireTeacherSession();
  const currency = await teacherCurrency(session.teacherId);
  return (
    <>
      <PageHeader title="New recurring class" backHref="/settings/recurring" backLabel="Recurring classes" />
      <TemplateForm mode="create" currency={currency} />
    </>
  );
}
