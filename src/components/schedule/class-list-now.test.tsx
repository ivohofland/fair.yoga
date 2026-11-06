import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ClassList } from './class-list';
import { classRow } from './class-list-fixtures';

/**
 * The schedule's "now" line: where the teacher is in their week and which
 * class is next. Amsterdam in November is CET (+01:00); every class here is
 * the fixture's 60 minutes long.
 */
const TZ = 'Europe/Amsterdam';
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const at = (local: string): Date => new Date(`${local}+01:00`);

const week = [
  classRow('thu', 'completed', [], { date: day('2026-11-05'), startTime: '19:45' }),
  classRow('sat', 'open', [], { date: day('2026-11-07'), startTime: '17:00' }),
  classRow('tue', 'open', [], { date: day('2026-11-10'), startTime: '19:30' }),
];

function renderSchedule(showNow = true) {
  render(<ClassList classes={week} timeZone={TZ} showNow={showNow} />);
}

/** The card link for a class, by id. */
function card(id: string): HTMLElement {
  const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === `/class/${id}`);
  if (!link) throw new Error(`no card for ${id}`);
  return link;
}

function isBefore(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('ClassList now line', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws the line, stamped with the time, between the last ended class and the next', () => {
    vi.setSystemTime(at('2026-11-06T10:52'));
    renderSchedule();

    const line = screen.getByText('Now · 10:52');
    expect(isBefore(card('thu'), line)).toBe(true);
    expect(isBefore(line, card('sat'))).toBe(true);
  });

  it('labels only the next class, in calendar words', () => {
    vi.setSystemTime(at('2026-11-06T10:52'));
    renderSchedule();

    const label = screen.getByText('Next · tomorrow at 17:00');
    expect(isBefore(label, card('sat'))).toBe(true);
    expect(screen.getAllByText(/^Next ·/)).toHaveLength(1);
  });

  it('labels a class in progress with its end time', () => {
    vi.setSystemTime(at('2026-11-07T17:20'));
    renderSchedule();

    expect(screen.getByText('On now · until 18:00')).toBeInTheDocument();
    expect(screen.getByText('Next · Tuesday at 19:30')).toBeInTheDocument();
    expect(isBefore(screen.getByText('Now · 17:20'), card('sat'))).toBe(true);
  });

  it('moves the line and its time when the teacher comes back to the page', () => {
    vi.setSystemTime(at('2026-11-06T10:52'));
    renderSchedule();

    vi.setSystemTime(at('2026-11-07T18:30'));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(screen.queryByText('Now · 10:52')).not.toBeInTheDocument();
    const line = screen.getByText('Now · 18:30');
    expect(isBefore(card('sat'), line)).toBe(true);
    expect(isBefore(line, card('tue'))).toBe(true);
    expect(screen.getByText('Next · Tuesday at 19:30')).toBeInTheDocument();
  });

  it('draws nothing on a list that does not ask for it', () => {
    vi.setSystemTime(at('2026-11-06T10:52'));
    renderSchedule(false);

    expect(screen.queryByText(/^Now ·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Next ·/)).not.toBeInTheDocument();
  });
});
