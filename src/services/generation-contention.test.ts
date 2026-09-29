import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '@/lib/log';
import {
  MAX_CONSECUTIVE_CONTENDED_SWEEPS,
  GenerationContendedError,
  createContentionStreaks,
  recordSweepContention,
} from './generation-contention';

const A = { templateId: 'tpl-A', teacherId: 't1' };
const B = { templateId: 'tpl-B', teacherId: 't2' };

function sweeps(streaks: ReturnType<typeof createContentionStreaks>, n: number, skipped = [A]) {
  let last: GenerationContendedError | null = null;
  for (let i = 0; i < n; i += 1) last = recordSweepContention(streaks, skipped, 'recurring class');
  return last;
}

describe('recordSweepContention', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tolerates MAX − 1 consecutive contended sweeps of the same template', () => {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    expect(sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1)).toBeNull();
    expect(streaks.byTemplate.get('tpl-A')).toBe(MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('escalates on the MAX-th consecutive contended sweep, naming only the stuck template', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1);
    // B joins on the last sweep: contended once, not stuck.
    const err = recordSweepContention(streaks, [A, B], 'recurring class');
    expect(err).toBeInstanceOf(GenerationContendedError);
    expect(err?.templateIds).toEqual(['tpl-A']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'tpl-A', teacherId: 't1', streak: MAX_CONSECUTIVE_CONTENDED_SWEEPS }),
      expect.stringContaining('recurring class'),
    );
  });

  it('keeps escalating while the template stays stuck, so a later sweep cannot report success', () => {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    expect(sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS + 1)).toBeInstanceOf(GenerationContendedError);
  });

  it('resets a template that was not contended in a sweep', () => {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1);
    expect(recordSweepContention(streaks, [], 'recurring class')).toBeNull();
    expect(streaks.byTemplate.has('tpl-A')).toBe(false);
    // Starting over: MAX − 1 more contended sweeps are tolerated again.
    expect(sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1)).toBeNull();
  });

  it('keeps separate trackers independent', () => {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const one = createContentionStreaks();
    const two = createContentionStreaks();
    sweeps(one, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1);
    expect(sweeps(two, 1)).toBeNull();
  });
});
