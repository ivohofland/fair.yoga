import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { createStudioClassTemplateSchema } from '@/lib/schemas';
import { generateStudioInstancesForTemplate } from '@/services/studio-class-generator';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { countSkipReasons, type GenerationResult } from '@/lib/generation';

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
  //
  // The catch sits OUTSIDE this call rather than inside it — same reasoning
  // as the class family's POST (`api/class-templates/route.ts`): a P2002
  // raised inside a Postgres transaction aborts that transaction, so there
  // is nothing to catch from within, and rolling the whole thing back is
  // correct anyway. Only the template's own P2002 can reach this catch —
  // `tx.studioClassTemplate.create` runs first and, on conflict, throws
  // before generation starts, so `generateStudioInstancesForTemplate`'s
  // `createManyAndReturn` (`skipDuplicates: true`) never gets a chance to
  // raise anything here even though it shares this transaction.
  let template: {
    created: Prisma.StudioClassTemplateGetPayload<{
      include: { teacher: { select: { defaultTimezone: true } } };
    }>;
    generation: GenerationResult;
  };
  try {
    template = await prisma.$transaction(async (tx) => {
      const created = await tx.studioClassTemplate.create({
        data: {
          teacherId: session.teacherId,
          ...parsed.data,
        },
        include: { teacher: { select: { defaultTimezone: true } } },
      });
      const generation = await generateStudioInstancesForTemplate(tx, created);
      return { created, generation };
    },
    // Same reasoning as the class family's POST — both or neither. Raising
    // one family's create budget without the other reintroduces exactly the
    // asymmetry #191 was designed to avoid.
    { timeout: 10_000 },
  );
  } catch (err) {
    // The template's slot key, not `StudioClass`'s — see the class family's
    // POST for why no modelName disambiguation is needed here.
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      return respondError(
        'You already have a recurring studio class on that day at that time.',
        409,
        'DUPLICATE_STUDIO_TEMPLATE_SLOT',
      );
    }
    throw err;
  }

  const { teacher, ...created } = template.created;
  void teacher;

  // The same counts the PATCH `active` arm carries — see the class family's
  // POST for why 201 with no counts stopped being a complete answer once the
  // slot pre-check could decline every candidate date, and for
  // `countSkipReasons` (`@/lib/generation`), the one place both reductions
  // live. The create form reads these and stays on the page to say so when
  // the window isn't full (`studio-template-form.tsx`).
  return respondOk(
    {
      ...created,
      added: template.generation.created,
      ...countSkipReasons(template.generation.skipped),
    },
    201,
  );
});
