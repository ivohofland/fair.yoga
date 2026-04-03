import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireStudent,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { updatePrivacySchema } from '@/lib/schemas';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  if (session.userId !== id) {
    return respondError('Access denied', 403);
  }

  const teacherId = request.nextUrl.searchParams.get('teacherId');
  if (!teacherId) {
    return respondError('Missing teacherId query parameter', 400);
  }

  const privacy = await prisma.studentPrivacy.findUnique({
    where: {
      studentId_teacherId: {
        studentId: id,
        teacherId,
      },
    },
  });

  if (!privacy) {
    return respondOk({
      studentId: id,
      teacherId,
      shareEmail: false,
      sharePhone: false,
      shareBirthday: false,
      shareAddress: false,
      receiveComms: true,
    });
  }

  return respondOk(privacy);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  if (session.userId !== id) {
    return respondError('Access denied', 403);
  }

  const parsed = await parseBody(request, updatePrivacySchema);
  if ('error' in parsed) return parsed.error;
  const { teacherId, ...privacyFields } = parsed.data;

  const privacy = await prisma.studentPrivacy.upsert({
    where: {
      studentId_teacherId: {
        studentId: id,
        teacherId,
      },
    },
    update: privacyFields,
    create: {
      studentId: id,
      teacherId,
      shareEmail: privacyFields.shareEmail ?? false,
      sharePhone: privacyFields.sharePhone ?? false,
      shareBirthday: privacyFields.shareBirthday ?? false,
      shareAddress: privacyFields.shareAddress ?? false,
      receiveComms: privacyFields.receiveComms ?? true,
    },
  });

  return respondOk(privacy);
}
