import { describe, it, expect } from 'vitest';
import { updateStudentSchema } from './schemas';
import { formatIssues } from './validation-message';
import { parseFieldErrors, PHONE_MAX, ADDRESS_MAX } from './contact-details';

describe('parseFieldErrors', () => {
  // The message comes from the real schema through the real formatter, so a
  // change to either side of the format fails here rather than in a browser.
  it('reads every field back out of what parseBody would send', () => {
    const r = updateStudentSchema.safeParse({
      phone: '1'.repeat(PHONE_MAX + 1),
      birthday: '2023-02-30',
      address: 'a'.repeat(ADDRESS_MAX + 1),
    });
    expect(r.success).toBe(false);
    const found = parseFieldErrors(r.success ? '' : formatIssues(r.error.issues));
    expect(Object.keys(found).sort()).toEqual(['address', 'birthday', 'phone']);
    expect(found.birthday).toMatch(/real date/);
    expect(found.phone).not.toMatch(/address/);
  });

  it('yields nothing for a message that does not open on a field prefix', () => {
    expect(parseFieldErrors('Something went wrong, phone: X')).toEqual({});
    expect(parseFieldErrors('Invalid JSON')).toEqual({});
  });
});
