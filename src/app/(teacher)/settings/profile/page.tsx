import { Suspense } from 'react';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { timeZoneOptions } from '@/lib/timezone-options';
import { PageHeader } from '@/components/layout/page-header';
import { ProfileForm } from '@/components/settings/profile-form';
import { ProfilePhotoField } from '@/components/settings/profile-photo-field';
import { DataAndDeletion } from '@/components/account/data-and-deletion';
import { AccountSecurity } from '@/components/account/account-security';
import { BankAccountForm } from '@/components/settings/bank-account-form';
import { PaymentLinkForm } from '@/components/settings/payment-link-form';
import { MollieConnectionPanel, MollieConnectionFallback } from '@/components/settings/mollie-connection-panel';
import { bankAccountDataSelect, accountInCurrency } from '@/lib/payment-methods';
import { maskedIdentifier } from '@/lib/bank-details';
import { parseMollieReturn } from '@/lib/mollie-return';
import { mollieDeps } from '@/services/mollie-deps';

interface ProfilePageProps {
  searchParams: Promise<{ mollie?: string | string[] }>;
}

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const session = await requireTeacherSession();
  const { mollie } = await searchParams;
  const deps = mollieDeps();

  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    include: { photo: { select: { id: true } }, bankAccounts: { select: bankAccountDataSelect, orderBy: { currency: 'asc' } } },
  });
  const current = accountInCurrency(teacher.bankAccounts, teacher.currency);
  const others = teacher.bankAccounts
    .filter((a) => a.currency !== teacher.currency)
    .map((a) => ({ currency: a.currency, masked: maskedIdentifier(a) }));

  return (
    <>
      <PageHeader title="Profile" backHref="/settings" backLabel="Settings" />
      <ProfilePhotoField
        teacherId={teacher.id}
        firstName={teacher.firstName}
        lastName={teacher.lastName}
        photoId={teacher.photo?.id ?? null}
      />
      <ProfileForm
        teacherId={teacher.id}
        email={teacher.email}
        timeZoneOptions={timeZoneOptions(teacher.defaultTimezone, new Date())}
        initial={{
          firstName: teacher.firstName,
          lastName: teacher.lastName,
          bio: teacher.bio,
          pageSlug: teacher.pageSlug,
          currency: teacher.currency,
          defaultVatPercent: teacher.defaultVatPercent.toNumber(),
          defaultTimezone: teacher.defaultTimezone,
        }}
      />

      <BankAccountForm
        key={teacher.currency}
        teacherId={teacher.id}
        currency={teacher.currency}
        initial={{
          holderName: current?.holderName ?? '',
          iban: current?.iban ?? '',
          bic: current?.bic ?? '',
          sortCode: current?.sortCode ?? '',
          accountNumber: current?.accountNumber ?? '',
          routingNumber: current?.routingNumber ?? '',
          bankCode: current?.bankCode ?? '',
        }}
        hasAccount={current !== null}
        others={others}
      />

      <PaymentLinkForm teacherId={teacher.id} initial={teacher.paymentLink ?? ''} hasLink={teacher.paymentLink !== null} />

      {deps !== null && (
        <Suspense fallback={<MollieConnectionFallback />}>
          <MollieConnectionPanel teacherId={teacher.id} deps={deps} status={parseMollieReturn(mollie)} />
        </Suspense>
      )}

      <section className="mt-10 pt-6 border-t border-border">
        <h2 className="type-subtitle mb-3">Sign-in</h2>
        <AccountSecurity email={teacher.email} redirectPath="/settings/profile" />
      </section>

      <DataAndDeletion role="teacher" accountId={session.accountId} />
    </>
  );
}
