import type { Currency, Prisma, PrismaClient, Teacher } from '@prisma/client';
import { switchTeacherCurrency, type CurrencySwitchResult } from './currency-switch';

/**
 * Saving a teacher's own profile fields, and with them a currency switch
 * (#758). Framework-agnostic: the caller validates the body and maps the
 * outcome to a response. A database refusal of a field (the `pageSlug` unique
 * key) is thrown, not returned, and rolls back anything the same save wrote.
 */

/** The fields a save writes as given, every one optional. */
export type TeacherProfileFields = Omit<Prisma.TeacherUpdateManyMutationInput, 'currency'>;

export type TeacherProfileInput = {
  /** Present only when the save names a currency. */
  currency?: Currency;
  fields: TeacherProfileFields;
};

/**
 * `gone`: the teacher is absent or erased, and nothing was written.
 * `unchanged`: the save named only the stored currency, and nothing was
 * written. `saved`: the row as written, with what the switch did when it
 * switched.
 */
export type TeacherProfileOutcome =
  | { kind: 'gone' }
  | { kind: 'unchanged'; teacher: Teacher }
  | { kind: 'saved'; teacher: Teacher; currencySwitch?: CurrencySwitchResult };

/**
 * Thrown when a save that holds the teacher's row finds it gone. A programmer
 * error, never a business outcome; thrown rather than returned so the
 * transaction rolls back instead of committing a switch beside a 404.
 */
export class TeacherProfileInvariantError extends Error {}

/**
 * The currency save's transaction budget, derived in `docs/lock-order.md`,
 * "Currency save's transaction budget (#758)". Prisma's 5s default would cut
 * a contended switch short with a code-less 503.
 */
const CURRENCY_SAVE_TIMEOUT_MS = 15_000;

export async function updateTeacherProfile(
  db: PrismaClient,
  teacherId: string,
  input: TeacherProfileInput,
): Promise<TeacherProfileOutcome> {
  if (input.currency !== undefined) return saveWithCurrency(db, teacherId, input.currency, input.fields);

  // Scoped to a live row. An erasure holds this row from its first statement
  // to its commit, so this write can wait behind one; once it commits the
  // row is re-checked, and matched by `id` alone it would still match and
  // write these fields onto the anonymised row. `docs/lock-order.md`, "The
  // `Teacher` row is the first lock (#758)".
  const { count } = await db.teacher.updateMany({ where: { id: teacherId, deletedAt: null }, data: input.fields });
  if (count === 0) return { kind: 'gone' };
  const teacher = await db.teacher.findUnique({ where: { id: teacherId } });
  return teacher === null ? { kind: 'gone' } : { kind: 'saved', teacher };
}

/**
 * The switch and the other fields in one transaction, the switch first: it
 * takes that transaction's first lock (`switchTeacherCurrency`). A refusal of
 * another field rolls the switch back with it.
 */
async function saveWithCurrency(
  db: PrismaClient,
  teacherId: string,
  currency: Currency,
  fields: TeacherProfileFields,
): Promise<TeacherProfileOutcome> {
  const hasFields = Object.keys(fields).length > 0;
  return db.$transaction(async (tx): Promise<TeacherProfileOutcome> => {
    const switched = await switchTeacherCurrency(tx, teacherId, currency);
    if (switched === 'teacher_gone') return { kind: 'gone' };
    if (switched === 'unchanged' && !hasFields) {
      return { kind: 'unchanged', teacher: await tx.teacher.findUniqueOrThrow({ where: { id: teacherId } }) };
    }
    if (hasFields) {
      // Live-row scoped like the plain save. The switch's lock read the row
      // live and holds it, so this cannot miss; a miss is thrown.
      const { count } = await tx.teacher.updateMany({ where: { id: teacherId, deletedAt: null }, data: fields });
      if (count === 0) {
        throw new TeacherProfileInvariantError(`teacher ${teacherId} went missing under its own lock`);
      }
    }
    const teacher = await tx.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    return switched === 'unchanged'
      ? { kind: 'saved', teacher }
      : { kind: 'saved', teacher, currencySwitch: switched };
  }, { timeout: CURRENCY_SAVE_TIMEOUT_MS });
}
