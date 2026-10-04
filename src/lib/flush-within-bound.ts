import { flushOutbox } from './attendance-outbox';
import { logRequestFailure } from './client-errors';

const FLUSH_BOUND_MS = 5_000;

/**
 * Waits for the owner's outbox flush, but never longer than 5 s, for a control
 * that must know what is still unsynced before it acts. `tag` names that
 * control in the log.
 */
export async function flushWithinBound(owner: string, tag: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_BOUND_MS);
  });
  const flushed = flushOutbox(owner).then(
    () => undefined,
    (err: unknown) => logRequestFailure(tag, { step: 'flush' }, err),
  );
  try {
    await Promise.race([flushed, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
