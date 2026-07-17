import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateStudioClassTemplateSchema } from '@/lib/schemas';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.studioClassTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Studio class template not found', 404);
  if (template.teacherId !== session.userId) return respondError('Access denied', 403);

  return respondOk(template);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.studioClassTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Studio class template not found', 404);
  if (template.teacherId !== session.userId) return respondError('Access denied', 403);

  const parsed = await parseBody(request, updateStudioClassTemplateSchema);
  if ('error' in parsed) return parsed.error;

  if (Object.keys(parsed.data).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const updated = await prisma.studioClassTemplate.update({
    where: { id },
    data: parsed.data,
  });

  return respondOk(updated);
});

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.studioClassTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Studio class template not found', 404);
  if (template.teacherId !== session.userId) return respondError('Access denied', 403);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'archive') {
    const updated = await prisma.studioClassTemplate.update({
      where: { id },
      data: { isArchived: !template.isArchived, isActive: false },
    });
    return respondOk(updated);
  }

  const updated = await prisma.studioClassTemplate.update({
    where: { id },
    data: { isActive: !template.isActive },
  });

  return respondOk(updated);
});
