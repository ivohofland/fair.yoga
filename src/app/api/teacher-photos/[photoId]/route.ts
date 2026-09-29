import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { respondError, withErrorHandler } from '@/lib/api-utils';
import { readTeacherPhoto } from '@/services/teacher-photo';

// Public: the teacher's public page shows it to signed-out visitors. The id is
// regenerated on every upload, so a response for one id never changes.
export const GET = withErrorHandler(async (
  _request: NextRequest,
  { params }: { params: Promise<{ photoId: string }> },
) => {
  const { photoId } = await params;
  const bytes = await readTeacherPhoto(prisma, photoId);
  if (bytes === null) return respondError('Photo not found', 404);
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});
