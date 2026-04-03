import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireStudent,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';

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

interface UpdatePrivacyBody {
  teacherId: string;
  shareEmail?: boolean;
  sharePhone?: boolean;
  shareBirthday?: boolean;
  shareAddress?: boolean;
  receiveComms?: boolean;
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

  const body = await parseBody<UpdatePrivacyBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  const { teacherId, ...privacyFields } = body;
  if (!teacherId) {
    return respondError('Missing teacherId in request body', 400);
  }

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
