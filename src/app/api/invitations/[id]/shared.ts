import { prisma } from '@/lib/db';
import { respondError } from '@/lib/api-utils';
import type { TeacherFacingInvitationSelect } from '@/lib/contacts';

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
 * `email` is selected for the resend route's dispatch, and PUT also reads it,
 * to compare against the incoming address and decide whether to reset
 * `delivered` (#502 Fix #3). A route that ignores a column pays nothing for
 * selecting it — with one exception, which is what the `satisfies` below
 * pins: see `TeacherFacingInvitationSelect` (`src/lib/contacts.ts`).
 */
export async function ownedInvitation(teacherId: string, id: string) {
  return prisma.invitation.findFirst({
    where: { id, teacherId },
    select: {
      id: true, status: true, isArchived: true, email: true,
    } satisfies TeacherFacingInvitationSelect,
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
export const NOT_FOUND = () => respondError('This contact no longer exists.', 404, 'NOT_FOUND');

/** The teacher action a contact refusal answers. */
export type ContactDoor = 'edit' | 'remove' | 'resend';

const DECLINED_MESSAGE = {
  edit: "This person declined, so their details can't be changed. You can archive this contact.",
  remove: 'This person declined. You can archive this contact, but it cannot be removed.',
  resend: "This person declined, so the invitation can't be sent again.",
} as const satisfies Record<ContactDoor, string>;

/**
 * The refusal a declined row earns, in one place. The code is the same at
 * every door; the sentence names the action the teacher just tried.
 */
export const DECLINED = (door: ContactDoor) =>
  respondError(DECLINED_MESSAGE[door], 409, 'DECLINED_IS_PERMANENT');

/**
 * The refusal a row this route may not write to earns — every caller that
 * refuses a non-pending row answers with this, the same "one sentence, one
 * place" reasoning `DECLINED` above follows. It says nothing about the
 * Students list: an accepted row can outlive its link.
 */
export const NOT_PENDING = () =>
  respondError(
    'This person already accepted your invitation. Reload to see the latest.',
    409,
    'NOT_PENDING',
  );
