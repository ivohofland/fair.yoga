import 'server-only';
import { log } from '@/lib/log';
import type { FireAndForget } from '@/lib/fire-and-forget';
import {
  DEGRADATION_CODES,
  type DegradationCode,
  type DegradationContext,
} from '@/lib/degradation-codes';
import { createCoalescer } from '@/lib/degradation-coalescer';

export const COALESCE_WINDOW_MS = 60_000;
export const MAX_CONTEXT_VALUE_LENGTH = 200;

/**
 * Keeps only the keys the code allows, as strings (truncated) or finite
 * numbers. A runtime filter on top of the types, because a cast passes every
 * type check and the context of a fallback can include a value read from a
 * corrupt row.
 */
function allowlisted(
  code: DegradationCode,
  context: Readonly<Record<string, unknown>>,
): Record<string, string | number> {
  const kept: Record<string, string | number> = {};
  for (const key of DEGRADATION_CODES[code].contextKeys) {
    const value = context[key];
    if (typeof value === 'string') kept[key] = value.slice(0, MAX_CONTEXT_VALUE_LENGTH);
    else if (typeof value === 'number' && Number.isFinite(value)) kept[key] = value;
  }
  return kept;
}

const coalescer = createCoalescer({
  windowMs: COALESCE_WINDOW_MS,
  now: () => new Date(),
  write: async (code, pending) => {
    // Imported on use: a module that only needs to log a fallback should not
    // open a database client at load.
    const [{ prisma }, { writeDegradationEvent }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/degradation-store'),
    ]);
    await writeDegradationEvent(prisma, {
      code,
      count: pending.count,
      at: pending.at,
      sample: pending.sample,
    });
  },
  onWriteError: (err, code) => {
    log.error({ err, code }, 'could not record a degradation event; the log line is all there is');
  },
});

/**
 * Reports an intentional fallback: logs the message and the allowlisted
 * context, and records the event so the operator is told
 * (`docs/degradation-sites.md`).
 *
 * `FireAndForget`: recording must never delay, fail or reveal anything about
 * the page that tripped the fallback, so there is no promise to await. If the
 * write fails, the failure is logged and the log line above is all that
 * remains.
 *
 * The types check object literals only (a variable or a spread is not checked
 * for extra keys), so the runtime allowlist is the guarantee.
 */
export function logDegraded<C extends DegradationCode>(
  code: C,
  context: DegradationContext<C>,
  message: string,
  err?: unknown,
): FireAndForget {
  // `?? {}`: the types forbid a null context, but a cast does not; a null one
  // is read as empty rather than throwing here.
  const safe = allowlisted(code, context ?? {});
  log[DEGRADATION_CODES[code].level](
    { ...safe, code, ...(err === undefined ? {} : { err }) },
    message,
  );
  coalescer.record(code, safe);
}
