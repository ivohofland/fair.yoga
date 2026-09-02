import { NextRequest } from 'next/server';
import { respondOk, respondError, parseBody, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { onboardingSkipSchema } from '@/lib/schemas';
import { isSettled } from '@/lib/onboarding';

/**
 * Records a skip (#385). Appends to `skippedOnboarding` idempotently.
 *
 * `step: 'share'` (dismissing the completion card) additionally requires
 * every other step to already be settled — `isOnboardingComplete`'s own
 * contract, which nothing enforced server-side before this: the checklist
 * UI only ever shows the Dismiss button once `GettingStarted` has computed
 * `settled` itself, but that is a rendering choice, not a guarantee a direct
 * request is bound by.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, onboardingSkipSchema);
  if ('error' in parsed) return parsed.error;

  if (parsed.data.step === 'share') {
    const [teacher, roomCount, classCount] = await Promise.all([
      prisma.teacher.findUniqueOrThrow({
        where: { id: session.teacherId },
        select: { bio: true, bankIban: true, skippedOnboarding: true },
      }),
      prisma.teacherRoom.count({ where: { teacherId: session.teacherId, isArchived: false } }),
      prisma.class.count({ where: { calendarEntry: { teacherId: session.teacherId } } }),
    ]);
    const settled = isSettled({
      bio: teacher.bio,
      bankIban: teacher.bankIban,
      roomCount,
      classCount,
      skipped: teacher.skippedOnboarding,
    });
    if (!settled) {
      return respondError('The checklist is not settled yet', 409, 'ONBOARDING_NOT_SETTLED');
    }
  }

  // `push` on a Postgres scalar list, guarded by a NOT-contains filter:
  // a double-tap must not store the member twice.
  await prisma.teacher.updateMany({
    where: { id: session.teacherId, NOT: { skippedOnboarding: { has: parsed.data.step } } },
    data: { skippedOnboarding: { push: parsed.data.step } },
  });

  return respondOk({ ok: true });
});
