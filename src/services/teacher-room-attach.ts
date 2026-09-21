import { Prisma, type TeacherRoom } from '@prisma/client';

/**
 * What an attach request finds when the teacher already holds a link to the
 * room: the link is archived, holds exactly the values the request carries,
 * or holds others.
 */
export type ExistingLinkVerdict = 'archived' | 'unchanged' | 'differs';

/** The values an attach request asks the new link to hold. */
export type RequestedLinkValues = {
  capacityOverride: number;
  rentalRate: number;
  equipmentNotes?: string | null;
};

/**
 * Compares the request with the stored link as the request's values would be
 * stored: `rentalRate` rounded to the two decimals `Decimal(10, 2)` keeps,
 * ties away from zero as Postgres rounds them, and an absent `equipmentNotes`
 * read as the `null` it is stored as.
 *
 * Archived first: a link the teacher has archived is refused whatever the
 * request carries, because the room is out of use until it is unarchived.
 */
export function compareExistingLink(
  existing: Pick<TeacherRoom, 'isArchived' | 'capacityOverride' | 'rentalRate' | 'equipmentNotes'>,
  requested: RequestedLinkValues,
): ExistingLinkVerdict {
  if (existing.isArchived) return 'archived';

  const requestedRate = new Prisma.Decimal(requested.rentalRate).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP,
  );
  const same =
    existing.capacityOverride === requested.capacityOverride &&
    existing.rentalRate.equals(requestedRate) &&
    existing.equipmentNotes === (requested.equipmentNotes ?? null);

  return same ? 'unchanged' : 'differs';
}
