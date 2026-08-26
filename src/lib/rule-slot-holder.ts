import type { PrismaClient } from '@prisma/client';
import { log } from './log';

/**
 * Which family's rule occupies a slot, asked after `ScheduleRule_teacher_slot_excl`
 * has already refused a write.
 *
 * `'unknown'` is not an error path: the refusing rule can be archived between the
 * failed write and this probe, and a refusal that names the wrong half of a
 * teacher's schedule is worse than one that names neither.
 */
export type RuleSlotHolder = 'regular' | 'studio' | 'unknown';

/**
 * `ScheduleRule.startTime` (a `@db.Time` column, read back as a `Date`) to the
 * unit this probe's `startMinutes` takes — the generated `slot` column is
 * minutes-since-midnight (the migration's own comment: "PostgreSQL has no
 * range type over `time`"), so a probe built from a stored row has to match
 * that, not the wire's `"HH:MM"`. Every caller of `ruleSlotHolder` needs this
 * exact conversion, so it lives beside the probe rather than once per caller.
 */
export function minutesSinceMidnight(t: Date): number {
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

/**
 * Reads the generated `slot` column directly, rather than re-deriving it from
 * `startTime`/`durationMinutes` in TypeScript, so this probe cannot disagree
 * with the constraint about what a slot IS. `slot` is `Unsupported("int4range")`
 * on the Prisma model (Task 1) and therefore absent from the generated client —
 * no `where` clause can reach it, which is why this is `$queryRaw` rather than
 * a typed `findFirst`.
 *
 * The `'[)'` duplicates `ScheduleRule_teacher_slot_excl`'s own half-open bound
 * (`prisma/migrations/20260825061213_schedule_rule/migration.sql`). That
 * duplication is the one thing here that can silently drift if the constraint
 * is ever redefined with a different bound — `rule-slot-holder.test.ts`'s
 * boundary case and its mutation are what hold it.
 *
 * Called from a `catch` block outside its transaction, always against `db`,
 * never `tx`: a statement that fails inside a Postgres transaction aborts it,
 * so a probe issued on the aborted `tx` would answer `25P02` rather than an
 * answer, not a `RuleSlotHolder`. Every call site must therefore sit after
 * its own transaction's closing `)`, where Prisma has already rolled back and
 * `db` is a clean connection — re-derive the current set rather than trust a
 * count here:
 *
 *   grep -rn "ruleSlotHolder(db\|ruleSlotHolder(prisma" src/services/ src/app/api/
 *
 * NEVER THROWS, and that is a guarantee about the refusal rather than about
 * this query — the same contract `probeConflictingEntry` (`./entry-conflict`)
 * carries one layer down, arrived at for the same reason. Every caller has
 * already been refused by the database and has already decided on 409; this
 * only decides how specific the sentence is. A throw from inside that `catch`
 * would escape to `withErrorHandler` and answer 5xx instead, reporting a write
 * the database CORRECTLY refused as one that may have happened. Contention is
 * also exactly when slot conflicts occur, so a pool or lock timeout on this
 * extra query is the realistic case rather than a hypothetical one — and it is
 * likeliest under the very contention that produced the conflict.
 *
 * It degrades to the same `'unknown'` the ordinary "the rule was archived
 * meanwhile" outcome produces, which is why there is a value to degrade TO.
 */
export async function ruleSlotHolder(
  db: PrismaClient,
  probe: {
    teacherId: string;
    dayOfWeek: number;
    startMinutes: number;
    durationMinutes: number;
    /** The row being updated, which conflicts with itself otherwise. */
    excludeRuleId?: string;
  },
): Promise<RuleSlotHolder> {
  try {
    const rows = await db.$queryRaw<Array<{ kind: string }>>`
      SELECT "kind"::text AS kind FROM "ScheduleRule"
       WHERE "teacherId" = ${probe.teacherId} AND "dayOfWeek" = ${probe.dayOfWeek} AND "isArchived" = false
         AND "slot" && int4range(${probe.startMinutes}::int, ${probe.startMinutes + probe.durationMinutes}::int, '[)')
         AND (${probe.excludeRuleId ?? null}::text IS NULL OR "id" <> ${probe.excludeRuleId ?? null}::text)
       LIMIT 1
    `;
    const kind = rows[0]?.kind;
    return kind === 'regular' || kind === 'studio' ? kind : 'unknown';
  } catch (err) {
    log.warn(
      {
        err,
        teacherId: probe.teacherId,
        dayOfWeek: probe.dayOfWeek,
        startMinutes: probe.startMinutes,
        durationMinutes: probe.durationMinutes,
      },
      'rule slot holder probe failed; the refusal will name neither family',
    );
    return 'unknown';
  }
}
