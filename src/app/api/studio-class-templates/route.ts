import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, parseBody, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { createStudioClassTemplateSchema } from '@/lib/schemas';
import { generateStudioInstancesForTemplate } from '@/services/studio-class-generator';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const templates = await prisma.studioClassTemplate.findMany({
    where: { teacherId: session.teacherId },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(templates);
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createStudioClassTemplateSchema);
  if ('error' in parsed) return parsed.error;

  // Atomic, matching `api/class-templates/route.ts` (#56): a generation failure
  // rolls the template create back and propagates a 500, rather than leaving a
  // template flagged live that produces no classes. Before this the studio POST
  // was a plain `create`, so a new template sat `isActive: true` with an empty
  // window until the hourly sweep — and the only control on screen ("Resume
  // studio class") answers `200 unchanged` and generates nothing (#120).
  //
  // No claim is taken, and that is reasoning rather than omission: this row's
  // uuid is brand-new inside this transaction, so nothing else can reference it
  // yet and nothing can race the insert. The same exemption
  // `claimStudioTemplateForGeneration` gives the class family's POST, and the
  // reason it does not generalise to a caller that reuses this shape against an
  // *existing* row.
  const template = await prisma.$transaction(async (tx) => {
    const created = await tx.studioClassTemplate.create({
      data: {
        teacherId: session.teacherId,
        ...parsed.data,
      },
      include: { teacher: { select: { defaultTimezone: true } } },
    });
    const generation = await generateStudioInstancesForTemplate(tx, created);
    return { created, generation };
  });

  const { teacher, ...created } = template.created;
  void teacher;

  // Same four fields the PATCH `active` arm carries — see the class family's
  // POST for why 201 with no counts stopped being a complete answer once the
  // slot pre-check could decline every candidate date.
  return respondOk(
    {
      ...created,
      added: template.generation.created,
      blockedByCancelled: template.generation.skipped.filter(
        (s) => s.reason === 'blocked_by_cancelled',
      ).length,
      slotTaken: template.generation.skipped.filter((s) => s.reason === 'slot_taken').length,
    },
    201,
  );
});
