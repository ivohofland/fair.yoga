import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from './log';
import { reportRuleKindMismatch } from './rule-kind-mismatch';

/**
 * Issue 328's detector, whose whole value is that it fires on exactly one
 * shape and stays silent on the two that look like it.
 *
 * A manual studio class has no rule and no template; a healthy generated one
 * has both. The state 328 records — a live rule id with no template of the
 * asking family — currently renders identically to the first of those, which is
 * why a silent detector would be worse than none.
 */
describe('reportRuleKindMismatch', () => {
  const spy = vi.spyOn(log, 'error').mockImplementation(() => log);

  afterEach(() => {
    spy.mockClear();
  });

  it('reports an entry whose rule carries no template of this family', () => {
    reportRuleKindMismatch('probe', { id: 'e1', scheduleRuleId: 'r1' }, null);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      site: 'probe',
      calendarEntryId: 'e1',
      scheduleRuleId: 'r1',
    });
  });

  it('stays silent for a manual entry, which carries no rule at all', () => {
    reportRuleKindMismatch('probe', { id: 'e2', scheduleRuleId: null }, null);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stays silent for a healthy generated entry', () => {
    reportRuleKindMismatch('probe', { id: 'e3', scheduleRuleId: 'r1' }, { id: 't1' });
    expect(spy).not.toHaveBeenCalled();
  });
});
