import { PageHeader } from '@/components/layout/page-header';
import { TemplateForm } from '@/components/settings/template-form';

export default function NewTemplatePage() {
  return (
    <>
      <PageHeader title="New recurring class" backHref="/settings/recurring" backLabel="Recurring classes" />
      <TemplateForm mode="create" />
    </>
  );
}
