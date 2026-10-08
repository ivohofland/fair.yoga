'use client';

import type { BankDetails } from '@/lib/bank-details';
import { CopyFieldList, type CopyField } from '@/components/student/copy-field-list';

interface PaymentDetailsProps {
  details: BankDetails;
  beneficiary: string;
  reference: string;
}

/** The account rows of one scheme, in the order a banking app asks for them. */
function accountFields(details: BankDetails): CopyField[] {
  switch (details.scheme) {
    case 'sepa':
    case 'iban':
      return [
        // Copied without the display grouping: some bank apps cap the field at the
        // IBAN's bare length and would cut a pasted, spaced one short.
        { key: 'IBAN', label: 'IBAN', shown: details.iban, copied: details.iban.replace(/\s/g, '') },
        ...(details.bic === null ? [] : [{ key: 'BIC', label: 'BIC', shown: details.bic, copied: details.bic }]),
      ];
    case 'uk':
      return [
        // Shown in the 12-34-56 grouping UK banks print; copied as bare digits.
        {
          key: 'sort code',
          label: 'Sort code',
          shown: details.sortCode.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3'),
          copied: details.sortCode,
        },
        { key: 'account number', label: 'Account number', shown: details.accountNumber, copied: details.accountNumber },
      ];
    case 'us':
      return [
        { key: 'routing number', label: 'Routing number', shown: details.routingNumber, copied: details.routingNumber },
        { key: 'account number', label: 'Account number', shown: details.accountNumber, copied: details.accountNumber },
      ];
    default: {
      const unhandled: never = details;
      console.error('[payment-details] unhandled bank scheme', { scheme: String((unhandled as { scheme?: unknown }).scheme) });
      return [];
    }
  }
}

/**
 * The transfer details, each copyable on its own.
 */
export function PaymentDetails({ details, beneficiary, reference }: PaymentDetailsProps) {
  const fields: ReadonlyArray<CopyField> = [
    { key: 'name', label: 'Name', shown: beneficiary, copied: beneficiary },
    ...accountFields(details),
    { key: 'reference', label: 'Reference', shown: reference, copied: reference },
  ];

  return <CopyFieldList fields={fields} />;
}
