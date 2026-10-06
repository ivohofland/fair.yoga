import { requireTeacherSession } from '@/lib/session';
import { teacherCurrency } from '@/lib/teacher-currency.server';
import { PageHeader } from '@/components/layout/page-header';
import { StudioTemplateForm } from '@/components/settings/studio-template-form';

export default async function NewStudioTemplatePage() {
  const session = await requireTeacherSession();
  const currency = await teacherCurrency(session.teacherId);
  return (
    <>
      <PageHeader title="New studio class" backHref="/settings/studio-classes" backLabel="Studio classes" />
      <StudioTemplateForm mode="create" currency={currency} />
    </>
  );
}
