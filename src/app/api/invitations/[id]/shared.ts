import { prisma } from '@/lib/db';
import { respondError } from '@/lib/api-utils';

/**
 * The ownership preamble shared by PUT/DELETE/PATCH
 * (`src/app/api/invitations/[id]/route.ts`) and
 * `POST /api/invitations/[id]/resend` (#173) — the teacher-facing routes
 * under this resource read the same row this way before deciding what
 * they're allowed to do to it. (`POST /api/invitations/[id]/respond` is
 * student-facing and authorizes by account email instead — see
 * `acceptInvitation`'s docblock, services/invitations.ts — so it has no
 * use for this.) Pulled into its own
 * file rather than exported from `route.ts` directly: Next's Route Handler
 * convention restricts what a `route.ts` file may export to HTTP verbs plus
 * a small fixed config allow-list.
 *
 * `findFirst` with `teacherId` in the `where`, not `findUnique` by id
 * followed by a separate ownership check — the ownership condition belongs
 * in the query itself, which is the shape this project's gate model calls
 * for (#162 was a PUT that skipped exactly this).
 *
 * `email` is selected for the resend route's dispatch — PUT/DELETE/PATCH
 * ignore it, which costs nothing extra to select alongside the other three.
 */
export async function ownedInvitation(teacherId: string, id: string) {
  return prisma.invitation.findFirst({
    where: { id, teacherId },
    select: { id: true, status: true, isArchived: true, email: true },
  });
}

/**
 * 404, not 403, when the row isn't this teacher's. The students routes
 * answer 403 for the equivalent case because a caller may legitimately know
 * a student id (they share a class roster, a booking link, etc). An
 * invitation id is never shared with anyone but the teacher who created it,
 * so its absence is the honest answer — a 403 would confirm the id exists
 * and belongs to someone else, which is a disclosure this route has no
 * reason to make.
 */
export const NOT_FOUND = () => respondError('Contact not found', 404);

/**
 * The refusal a declined row earns, in one place — PUT's pre-check, DELETE's
 * pre-check, both of their post-CAS answers (via `casMatchedNothing`,
 * `route.ts`), and resend's pre-check all say exactly this, and each copy
 * of one sentence is another chance for them to stop agreeing.
 */
export const DECLINED = () =>
  respondError(
    'This person declined. You can archive this contact, but it cannot be removed.',
    409,
    'DECLINED_IS_PERMANENT',
  );
