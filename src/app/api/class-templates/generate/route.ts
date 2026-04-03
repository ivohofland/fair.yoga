import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, isErrorResponse } from '@/lib/api-utils';
import { generateClassInstances } from '@/services/class-generator';

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const count = await generateClassInstances(prisma);

  return respondOk({ created: count });
}
