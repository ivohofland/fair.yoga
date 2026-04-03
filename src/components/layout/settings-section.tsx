import type { Teacher } from '@prisma/client';

type TeacherWithCounts = Teacher & {
  _count: { teacherRooms: number };
};

interface SettingsSectionProps {
  teacher: TeacherWithCounts;
}

function maskIban(iban: string | null): string {
  if (!iban) return 'Not set';
  if (iban.length <= 4) return iban;
  return '****' + iban.slice(-4);
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-border">
      <span className="text-brown text-xs">{label}</span>
      <span className="text-dark text-sm">{value}</span>
    </div>
  );
}

export function SettingsSection({ teacher }: SettingsSectionProps) {
  return (
    <div>
      <SettingsRow
        label="Name"
        value={`${teacher.firstName} ${teacher.lastName}`}
      />
      <SettingsRow label="Email" value={teacher.email} />
      <SettingsRow
        label="Page"
        value={`fair.yoga/${teacher.pageSlug}`}
      />
      <SettingsRow
        label="Rooms"
        value={`${teacher._count.teacherRooms} configured`}
      />
      <SettingsRow
        label="Bank account"
        value={maskIban(teacher.bankIban)}
      />
      <SettingsRow label="Currency" value={teacher.defaultCurrency} />
      <SettingsRow label="Timezone" value={teacher.defaultTimezone} />
    </div>
  );
}
