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
import { withSlot } from '@/services/studio-class-template-lifecycle';
import { hhmmToTime } from '@/lib/time-of-day';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { ruleSlotHolder, minutesSinceMidnight, type RuleSlotHolder } from '@/lib/rule-slot-holder';
import { isCrossFamilySlotConflict } from '@/lib/cross-family-conflict';
import { log } from '@/lib/log';
import { countSkipReasons, type GenerationResult } from '@/lib/generation';

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
  // TRUE OF P2002 always, and TRUE OF `YG001` (#296) only from generation now.
  // Generation shares this transaction, and its `StudioClass` insert fires the
  // entry-level cross-family trigger — the ONE `YG001` source left in this
  // transaction. The template insert used to be a second: two template-level
  // triggers raised it before issue 298 replaced both with
  // `ScheduleRule_teacher_slot_excl` below, a single exclusion constraint that
  // raises `23P01` instead, for either family. A `conflict.level` object used
  // to sit here disambiguating which statement raised a `YG001` — the
  // template's own insert, or generation's — because both could. That
  // question no longer has two answers, so the object that asked it is gone
  // with the second answer.
  let template: {
    created: Prisma.StudioClassTemplateGetPayload<{
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } };
    }>;
    generation: GenerationResult;
  };
  try {
    template = await prisma.$transaction(async (tx) => {
      // Nested create (issue 298): `ScheduleRule` holds the slot now, so the
      // template and its rule are born together in one statement.
      const created = await tx.studioClassTemplate.create({
        data: {
          scheduleRule: {
            create: {
              teacherId: session.teacherId,
              kind: 'studio',
              classType: parsed.data.classType,
              dayOfWeek: parsed.data.dayOfWeek,
              startTime: hhmmToTime(parsed.data.startTime),
              durationMinutes: parsed.data.durationMinutes,
            },
          },
          location: parsed.data.location,
          hourlyRate: parsed.data.hourlyRate,
        },
        include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
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
    // The template's own slot, either family: `ScheduleRule_teacher_slot_excl`
    // (issue 298) spans both, since `kind` is not part of its key. Only the
    // template create can raise it here — generation's `StudioClass` insert
    // is a different table under a different constraint.
    if (isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')) {
      const heldBy = await ruleSlotHolder(prisma, {
        teacherId: session.teacherId,
        dayOfWeek: parsed.data.dayOfWeek,
        startMinutes: minutesSinceMidnight(hhmmToTime(parsed.data.startTime)),
        durationMinutes: parsed.data.durationMinutes,
      });
      log.warn(
        { err, teacherId: session.teacherId, heldBy },
        'recurring studio class create refused: that slot is taken',
      );
      const [message, code] = SLOT_TAKEN[heldBy];
      return respondError(message, 409, code);
    }
    // The OTHER family's INSTANCE holds it (#296) — a `YG001` from the
    // entry-level cross-family trigger, which generation's own `StudioClass`
    // insert can raise and the branch above cannot: the template's own
    // collision is caught there now, by the exclusion constraint, not by this
    // trigger. LOGGED before responding: the pre-checks mirror the trigger
    // predicates exactly, so this is reachable ONLY through the cross-family
    // race this design knowingly accepts. `docs/lock-order.md` records that
    // race as "measured at 200 of 200 runs under a FORCED overlap — a rate
    // conditional on racing, not a rate of races, which was never measured".
    // A silent 409 would guarantee it stays unmeasured forever, because
    // production would emit nothing when one happened.
    if (isCrossFamilySlotConflict(err)) {
      log.warn(
        { err, teacherId: session.teacherId },
        'recurring studio class create refused: the class family holds that slot',
      );
      return respondError(
        'You already have a class on one of those dates at that time.',
        409,
        'CROSS_FAMILY_CLASS_SLOT',
      );
    }
    throw err;
  }

  const { scheduleRule, ...bare } = template.created;
  const created = withSlot(bare, scheduleRule);

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
      // One field rather than a spread — see the class family's twin for why
      // nesting buys something the spread did not.
      counts: countSkipReasons(template.generation.skipped),
    },
    201,
  );
});
