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
 * Called after its transaction has closed, always against `db`, never `tx` —
 * two requirements, held by two different things.
 *
 * THE ARGUMENT is held by the signature. A statement that fails inside a
 * Postgres transaction aborts it, so a probe issued on the aborted `tx` would
 * answer `25P02` rather than a `RuleSlotHolder`; that is why the parameter is
 * `PrismaClient`, which `Prisma.TransactionClient` — `Omit<PrismaClient,
 * ITXClientDenyList>`, missing `$transaction` — cannot satisfy. Passing `tx`
 * therefore does not compile, and `rule-slot-holder.test.ts` keeps a
 * never-called `@ts-expect-error` over that call so a parameter widened to
 * accept a transaction client fails `tsc` rather than shipping.
 *
 * THE PLACEMENT is the other requirement, and the failure it is about is not
 * `25P02`. What compiles is a call sitting INSIDE a `$transaction(…)` callback
 * and passing the outer `db`: it asks the pool for a second connection while
 * the caller's own transaction still holds the first — under exactly the
 * contention that produces slot conflicts — and reads a committed snapshot
 * blind to the very transaction it is being asked about. So no call site sits
 * inside one: either after its own transaction's closing `)`, where Prisma has
 * already committed or rolled back and `db` is a clean connection, or — where
 * the refused transaction lives one layer down, inside a service the caller
 * awaited — with no `)` of its own to sit after.
 *
 * Call sites reach this probe from a `catch`, where the refused statement
 * aborted the transaction, and from a normal return path, where a zero-row
 * `ON CONFLICT DO NOTHING` refusal never threw and the transaction committed.
 * Both requirements above hold identically either way, and they are all this
 * docblock asserts about call sites.
 *
 * NO ROSTER HERE, for the reason `db-locks.ts` spends a paragraph on: a caller
 * list kept in this file goes stale and nothing that counts can catch it. A
 * further caller of either shape falsifies a name; it does not falsify either
 * requirement above. Re-derive the set — on the bare name rather than on a
 * receiver, so a call made through a client named something else is still in
 * it:
 *
 *   grep -rn "ruleSlotHolder(" src/services/ src/app/api/
 *
 * THE PLACEMENT IS ENFORCED, and by something other than that command:
 * `src/lib/probe-placement-census.test.ts` reads the calls out of the syntax
 * tree and asserts that no call to a probe it censuses — this one among them —
 * sits lexically inside a `$transaction(…)` callback. A call site that moves
 * inside one reddens the suite, so the command above is a convenience for a
 * reader rather than the thing holding the rule up — and a narrower net than
 * what is enforced, since the census walks every non-test `.ts`/`.tsx` under
 * `src/` and follows import aliases, so a call site the two directories above
 * miss is held all the same.
 *
 * IT DOES NOT ASK FOR A TRANSACTION BESIDE THE CALL, only that there is none
 * around it. A caller whose refused transaction lived one layer down, inside
 * the service it awaited, would be correct. Nor does anything mechanical
 * decide whether the transaction a call probes after is the RIGHT one. The
 * census's own docblock carries the rest of what it does not see.
 *
 * NEVER THROWS, and that is a guarantee about the refusal rather than about
 * this query — the same contract `probeConflictingEntry` (`./entry-conflict`)
 * carries one layer down, arrived at for the same reason. Every caller has
 * already been refused by the database and has already decided on 409; this
 * only decides how specific the sentence is. A throw from any call site —
 * inside a `catch` or on the template creates' return path alike — escapes
 * to `withErrorHandler` and answers 5xx instead, reporting a write the
 * database CORRECTLY refused as one that may have happened. Contention is
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
