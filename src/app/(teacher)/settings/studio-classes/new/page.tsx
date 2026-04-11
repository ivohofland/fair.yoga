import { PageHeader } from '@/components/layout/page-header';
import { StudioTemplateForm } from '@/components/settings/studio-template-form';

export default function NewStudioTemplatePage() {
  return (
    <>
      <PageHeader title="New studio class" backHref="/settings/studio-classes" backLabel="Studio classes" />
      <StudioTemplateForm mode="create" />
    </>
  );
}
