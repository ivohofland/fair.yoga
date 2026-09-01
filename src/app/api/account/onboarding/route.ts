import { NextRequest } from 'next/server';
import { respondOk, parseBody, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { onboardingSkipSchema } from '@/lib/schemas';

/** Records a skip (#385). Appends to `skippedOnboarding` idempotently. */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, onboardingSkipSchema);
  if ('error' in parsed) return parsed.error;

  // `push` on a Postgres scalar list, guarded by a NOT-contains filter:
  // a double-tap must not store the member twice.
  await prisma.teacher.updateMany({
    where: { id: session.teacherId, NOT: { skippedOnboarding: { has: parsed.data.step } } },
    data: { skippedOnboarding: { push: parsed.data.step } },
  });

  return respondOk({ ok: true });
});
