import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, parseBody, isErrorResponse } from '@/lib/api-utils';
import { createStudioClassTemplateSchema } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const templates = await prisma.studioClassTemplate.findMany({
    where: { teacherId: session.userId },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(templates);
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createStudioClassTemplateSchema);
  if ('error' in parsed) return parsed.error;

  const template = await prisma.studioClassTemplate.create({
    data: {
      teacherId: session.userId,
      ...parsed.data,
    },
  });

  return respondOk(template, 201);
}
