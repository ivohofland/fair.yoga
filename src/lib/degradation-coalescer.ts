/**
 * Turns a stream of occurrences into at most one write per code per window.
 *
 * The first occurrence after a quiet window writes at once. Later ones inside
 * the window are held as a count plus the latest sample, and an `unref`'d timer
 * writes them when the window ends — without that trailing write, an
 * occurrence landing just after a flush and followed by nothing would never
 * reach the row, and the digest's "fired again since last told" test could not
 * see it. Occurrences still held when the process exits are lost, so the count
 * is approximate by construction.
 *
 * Pure: the clock, the write and the error sink are injected, so it is tested
 * with fake timers and no database.
 */

export interface PendingDegradation {
  readonly count: number;
  /** When the latest held occurrence happened. */
  readonly at: Date;
  readonly sample: Readonly<Record<string, string | number>>;
}

export interface CoalescerDeps {
  write: (code: string, pending: PendingDegradation) => Promise<void>;
  windowMs: number;
  now: () => Date;
  onWriteError: (err: unknown, code: string) => void;
}

interface CodeState {
  lastFlushAtMs: number | null;
  pending: PendingDegradation | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createCoalescer(deps: CoalescerDeps): {
  record(code: string, sample: PendingDegradation['sample']): void;
} {
  const states = new Map<string, CodeState>();

  function flush(code: string, state: CodeState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const pending = state.pending;
    if (pending === null) return;
    state.pending = null;
    state.lastFlushAtMs = deps.now().getTime();
    try {
      deps.write(code, pending).catch((err: unknown) => deps.onWriteError(err, code));
    } catch (err) {
      deps.onWriteError(err, code);
    }
  }

  return {
    record(code, sample) {
      const at = deps.now();
      let state = states.get(code);
      if (state === undefined) {
        state = { lastFlushAtMs: null, pending: null, timer: null };
        states.set(code, state);
      }
      state.pending = { count: (state.pending?.count ?? 0) + 1, at, sample };

      const sinceFlushMs =
        state.lastFlushAtMs === null ? Number.POSITIVE_INFINITY : at.getTime() - state.lastFlushAtMs;
      if (sinceFlushMs >= deps.windowMs) {
        flush(code, state);
        return;
      }
      if (state.timer === null) {
        const held = state;
        held.timer = setTimeout(() => flush(code, held), deps.windowMs - sinceFlushMs);
        held.timer.unref?.();
      }
    },
  };
}
