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
import { createStudioClassTemplateSchema } from '@/lib/schemas';
import { withSlot, createStudioClassTemplate } from '@/services/studio-class-template-lifecycle';
import type { RuleSlotHolder } from '@/lib/rule-slot-holder';
import { log } from '@/lib/log';
import { countSkipReasons } from '@/lib/generation';

/**
 * Mirrors `class-templates/route.ts`'s `SLOT_TAKEN` — see that file for why
 * `heldBy` replaces two reasons, and why the `satisfies` is load-bearing.
 */
const SLOT_TAKEN = {
  studio: [
    'You already have a recurring studio class at an overlapping time on that day.',
    'DUPLICATE_STUDIO_TEMPLATE_SLOT',
  ],
  regular: [
    'You already have a recurring class at an overlapping time on that day.',
    'CROSS_FAMILY_CLASS_TEMPLATE_SLOT',
  ],
  unknown: [
    'You already have a recurring class or studio class at an overlapping time on that day.',
    'STUDIO_TEMPLATE_SLOT_CONFLICT',
  ],
} as const satisfies Record<RuleSlotHolder, readonly [string, string]>;

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const templates = await prisma.studioClassTemplate.findMany({
    where: { scheduleRule: { teacherId: session.teacherId } },
    include: { scheduleRule: true },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(
    templates.map(({ scheduleRule, ...bare }) => withSlot(bare, scheduleRule)),
  );
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createStudioClassTemplateSchema);
  if ('error' in parsed) return parsed.error;

  const result = await createStudioClassTemplate(prisma, session.teacherId, parsed.data);

  if (!result.ok && result.reason === 'slot_conflict') {
    log.warn(
      { teacherId: session.teacherId, heldBy: result.heldBy },
      'recurring studio class create refused: that slot is taken',
    );
    const [message, code] = SLOT_TAKEN[result.heldBy];
    return respondError(message, 409, code);
  }
  if (!result.ok && result.reason === 'busy') {
    return respondError(
      'The system was busy and could not create this recurring studio class. Nothing was created. Wait a moment, then try again.',
      503,
      'STUDIO_TEMPLATE_BUSY',
    );
  }
  if (!result.ok) {
    // Exhaustiveness: a new CreateStudioTemplateResult arm becomes a compile
    // error here rather than being answered as a success.
    const unhandled: never = result;
    return unhandled;
  }

  // The same counts the PATCH `active` arm carries — see the class family's
  // POST for why 201 with no counts stopped being a complete answer once the
  // slot pre-check could decline every candidate date, and for
  // `countSkipReasons` (`@/lib/generation`), the one place both reductions
  // live. The create form reads these and stays on the page to say so when
  // the window isn't full (`studio-template-form.tsx`).
  return respondOk(
    {
      ...result.template,
      added: result.generation.created,
      // One field rather than a spread — see the class family's twin for why
      // nesting buys something the spread did not.
      counts: countSkipReasons(result.generation.skipped),
    },
    201,
  );
});
