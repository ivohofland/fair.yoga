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
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { isCrossFamilySlotConflict } from '@/lib/cross-family-conflict';
import { log } from '@/lib/log';
import { countSkipReasons, type GenerationResult } from '@/lib/generation';

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
  // An OBJECT, not a `let`, and that is the whole of why. TypeScript does not
  // track assignments made inside a closure, so a mutable local read in the
  // outer `catch` narrows to its initialiser — measured: with a
  // `let conflictLevel: 'template' | 'instance' | null`, a TYPO AT THE READ
  // (`=== 'instancez'`) compiled clean and silently took the other branch,
  // shipping the wrong 409 sentence forever. The union guarded the assignment
  // and nothing at the read, and it only compiled at all because `null` is
  // exempt from the no-overlap check — narrowing the union to two members
  // turned the read into a build error, which is the tell that the type was
  // inert by accident.
  //
  // Sharper than that, measured: the two-member `let` does not merely fail to
  // catch the typo — it rejects the CORRECT comparison too. CFA pins the read
  // to the initialiser, so `=== 'instance'` is itself `TS2367 … types
  // '"template"' and '"instance"' have no overlap`. The `let` is not the
  // weakest of the three candidate shapes; it is the only one that cannot
  // express this at all.
  //
  // A `const` object keeps its property's declared type across the closure, so
  // the comparison below is checked: the same typo is `TS2367 … types
  // '"template" | "instance"' and '"instancez"' have no overlap`. Measured
  // against all three candidate shapes before choosing this one.
  // THREE states, not two, and the third is the one that carries information.
  // `'untagged'` means no statement claimed this error — which today implies
  // the template insert, because it runs first and generation is the only other
  // raiser. That implication is an INFERENCE, and the log below must not
  // present it as a measurement: an earlier version defaulted to `'template'`,
  // so a race and a template conflict emitted the same field value and the one
  // number this design leaves unmeasured stayed unmeasurable. The response copy
  // still treats untagged as template — that inference is sound today — but the
  // log says what was actually observed.
  //
  // It stops being sound the moment a third `YG001`-capable statement joins
  // this transaction, which #228 (move this into a service) would do.
  const conflict = { level: 'untagged' as 'untagged' | 'instance' };
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
      const generation = await generateStudioInstancesForTemplate(tx, created).catch((err: unknown) => {
        // Set on the failure path only, immediately before rethrowing, so the
        // catch below can word the 409 for the statement that actually raised.
        if (isCrossFamilySlotConflict(err)) conflict.level = 'instance';
        throw err;
      });
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
    // The OTHER family holds it (#296) — a `YG001` from the cross-family
    // trigger, which is not a P2002 and so passes straight through the branch
    // above. Same status, deliberately different sentence: that clash is fixed
    // within this family, this one sends the teacher to the other half of
    // their schedule.
    // LOGGED before responding, and this one earns it twice over. Besides the
    // rule above, the `instance` arm is reachable ONLY through the cross-family
    // race this design knowingly accepts: the pre-checks mirror the trigger
    // predicates exactly, so nothing else can raise here. `docs/lock-order.md`
    // records that race as "measured at 200 of 200 runs under a FORCED overlap
    // — a rate conditional on racing, not a rate of races, which was never
    // measured". A silent 409 would guarantee it stays unmeasured forever,
    // because production would emit nothing when one happened. `conflictLevel`
    // is logged so the race arm is greppable and countable.
    if (isCrossFamilySlotConflict(err)) {
      log.warn(
        { err, teacherId: session.teacherId, conflictLevel: conflict.level },
        'recurring studio class create refused: the class family holds that slot',
      );
      // Which sentence depends on which statement raised — see `conflict` and
      // the note above the transaction. `'untagged'` is the fall-through, and
      // the RESPONSE reads it as the template case: the template insert runs
      // FIRST, so anything untagged came from it. The LOG keeps the two apart
      // on purpose, which is the whole reason the third state exists.
      //
      // This comment said "`'template'` is the default" until PR #300's fourth
      // pass — fifteen lines below the note explaining that an earlier version
      // defaulted to `'template'` and no longer does, in both parallel files
      // identically. `'template'` is not in the union at all now: nothing
      // assigned it and nothing compared against it, so a reader following the
      // sentence would grep the logs for a value that can never appear.
      return conflict.level === 'instance'
        ? respondError(
            'You already have a class on one of those dates at that time.',
            409,
            'CROSS_FAMILY_CLASS_SLOT',
          )
        : respondError(
            'You already have a recurring class on that day at that time.',
            409,
            'CROSS_FAMILY_CLASS_TEMPLATE_SLOT',
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
