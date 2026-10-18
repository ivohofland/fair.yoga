import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { respondTyped, respondError, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import type { TeacherSession } from '@/lib/types';
import { startConnect } from '@/services/processor-connection';
import { mollieDeps } from '@/services/mollie-deps';

type Params = { params: Promise<{ id: string }> };

/** The session, when it is the teacher the path names; otherwise the refusal. */
async function authorise(request: NextRequest, { params }: Params): Promise<TeacherSession | NextResponse> {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  if (session.teacherId !== id) return respondError('Access denied', 403);
  return session;
}

/** Starts a Mollie connect bound to this session and answers where the browser goes next. */
export const POST = withErrorHandler(async (request: NextRequest, context: Params) => {
  const session = await authorise(request, context);
  if (session instanceof NextResponse) return session;
  const deps = mollieDeps();
  if (deps === null) return respondError('Mollie isn’t available right now.', 503, 'PROCESSOR_UNAVAILABLE');

  const { authorizeUrl } = await startConnect(prisma, deps, { teacherId: session.teacherId, sessionId: session.sessionId });
  return respondTyped<{ authorizeUrl: string }>({ authorizeUrl });
});
