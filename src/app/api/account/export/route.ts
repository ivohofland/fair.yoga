import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireSession, isErrorResponse } from '@/lib/api-utils';
import { exportStudentData, exportTeacherData } from '@/services/gdpr';

/**
 * GDPR data export (Art. 15/20): everything we hold about the signed-in
 * account, as a downloadable JSON file.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const data =
    session.userType === 'student'
      ? await exportStudentData(prisma, session.userId)
      : await exportTeacherData(prisma, session.userId);

  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="fair-yoga-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
