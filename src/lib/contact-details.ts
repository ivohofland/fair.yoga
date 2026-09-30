import { ISSUE_SEPARATOR } from '@/lib/validation-message';

/** A student's optional contact fields, as `updateStudentSchema` names them. */
export const CONTACT_FIELDS = ['phone', 'birthday', 'address'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

export const PHONE_MAX = 40;
export const ADDRESS_MAX = 300;

export type FieldErrors = Partial<Record<ContactField, string>>;

export function isContactField(key: string): key is ContactField {
  return (CONTACT_FIELDS as ReadonlyArray<string>).includes(key);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FIELD_PREFIX = new RegExp(
  `(?:^|${escapeRegExp(ISSUE_SEPARATOR)})(${CONTACT_FIELDS.join('|')}): `,
);

/**
 * Reads a `formatIssues` message back into per-field text, in the order it
 * lists them. A message that does not open on a contact field's prefix yields
 * nothing, so the caller shows the whole of it as a banner.
 */
export function parseFieldErrors(message: string): FieldErrors {
  const parts = message.split(FIELD_PREFIX);
  const found: FieldErrors = {};
  if (parts[0] !== '') return found;
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const field = parts[i] ?? '';
    const text = parts[i + 1];
    if (isContactField(field) && text !== undefined) found[field] = text;
  }
  return found;
}
