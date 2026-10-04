import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { SyncStatus } from './sync-status';
import type { OutboxEntry, OutboxSnapshot, RefusedEntry } from '@/lib/attendance-outbox';

const { snapshot, listeners, dismissRefused, dismissNote, pathname } = vi.hoisted(() => ({
  snapshot: { current: null as OutboxSnapshot | null },
  listeners: new Set<() => void>(),
  dismissRefused: vi.fn((_owner: string, _registrationId: string) => {}),
  dismissNote: vi.fn((_owner: string, _classId: string) => {}),
  pathname: { current: '/class/c1' },
}));

vi.mock('@/lib/attendance-outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attendance-outbox')>();
  return {
    EMPTY_OUTBOX: actual.EMPTY_OUTBOX,
    getOutboxSnapshot: (_owner: string) => snapshot.current ?? actual.EMPTY_OUTBOX,
    subscribeOutbox: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismissRefused,
    dismissNote,
  };
});
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

function entry(id: string, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    registrationId: id,
    classId: 'c1',
    classLabel: 'Hatha · Tue 6 Oct 18:00',
    studentName: `Student ${id}`,
    target: 'attended',
    nonce: `n-${id}`,
    recordedAt: 1,
    attempts: 0,
    knownCompleted: false,
    ...overrides,
  };
}

function refused(id: string, message: string): RefusedEntry {
  return { ...entry(id), message, refusedAt: 2 };
}

function snap(overrides: Partial<OutboxSnapshot>): OutboxSnapshot {
  return { queued: [], refused: [], notes: [], needsSignIn: false, confirmed: {}, ...overrides };
}

/** Sets the store's answer and tells subscribers, as the module does on a change. */
function publish(next: OutboxSnapshot | null): void {
  act(() => {
    snapshot.current = next;
    listeners.forEach((listener) => listener());
  });
}

beforeEach(() => {
  snapshot.current = null;
  listeners.clear();
  dismissRefused.mockReset();
  dismissNote.mockReset();
  pathname.current = '/class/c1';
});

describe('SyncStatus', () => {
  it('renders nothing for the empty outbox', () => {
    const { container } = render(<SyncStatus owner="account-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on the server, whatever the device holds', () => {
    snapshot.current = snap({ queued: [entry('r1')], refused: [refused('r2', 'No.')], needsSignIn: true });
    expect(renderToString(<SyncStatus owner="account-1" />)).toBe('');
  });

  it('says one change is waiting, and a visible block, not a screen-reader-only one', () => {
    snapshot.current = snap({ queued: [entry('r1')] });
    const { container } = render(<SyncStatus owner="account-1" />);
    const line = screen.getByText('1 change waiting to sync');
    expect(line).toBeVisible();
    expect(container.querySelector('.sr-only')).toBeNull();
  });

  it('says how many changes are waiting', () => {
    snapshot.current = snap({ queued: [entry('r1'), entry('r2'), entry('r3')] });
    render(<SyncStatus owner="account-1" />);
    expect(screen.getByText('3 changes waiting to sync')).toBeInTheDocument();
  });

  it('follows the store: appears on a change and disappears when it empties', () => {
    const { container } = render(<SyncStatus owner="account-1" />);
    expect(container).toBeEmptyDOMElement();
    publish(snap({ queued: [entry('r1')] }));
    expect(screen.getByText('1 change waiting to sync')).toBeInTheDocument();
    publish(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists one refusal with student, class and the server message, and its Dismiss works offline', () => {
    snapshot.current = snap({ refused: [refused('r1', 'This class was cancelled.')] });
    render(<SyncStatus owner="account-1" />);
    expect(screen.getByText("1 change couldn't be saved")).toBeInTheDocument();
    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('Student r1');
    expect(item).toHaveTextContent('Hatha · Tue 6 Oct 18:00');
    expect(item).toHaveTextContent('This class was cancelled.');
    const dismiss = screen.getByRole('button', { name: 'Dismiss: Student r1, Hatha · Tue 6 Oct 18:00' });
    expect(dismiss).toHaveAttribute('data-offline-writable');
    act(() => dismiss.click());
    expect(dismissRefused).toHaveBeenCalledWith('account-1', 'r1');
  });

  it('counts several refusals', () => {
    snapshot.current = snap({ refused: [refused('r1', 'A.'), refused('r2', 'B.')] });
    render(<SyncStatus owner="account-1" />);
    expect(screen.getByText("2 changes couldn't be saved")).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('asks to sign in again for one change, linking back to this page', () => {
    pathname.current = '/class/c 1';
    snapshot.current = snap({ queued: [entry('r1')], needsSignIn: true });
    render(<SyncStatus owner="account-1" />);
    const link = screen.getByRole('link', { name: 'Sign in again to sync 1 change' });
    expect(link).toHaveAttribute('href', `/login?redirect=${encodeURIComponent('/class/c 1')}`);
    // The sign-in line says what is waiting; the waiting line would repeat it.
    expect(screen.queryByText('1 change waiting to sync')).toBeNull();
  });

  it('asks to sign in again for several changes', () => {
    snapshot.current = snap({ queued: [entry('r1'), entry('r2')], needsSignIn: true });
    render(<SyncStatus owner="account-1" />);
    expect(screen.getByRole('link', { name: 'Sign in again to sync 2 changes' })).toBeInTheDocument();
  });

  it('shows each completion note with a Dismiss that calls the module', () => {
    snapshot.current = snap({
      notes: [
        { classId: 'c1', classLabel: 'Hatha · Tue 6 Oct 18:00' },
        { classId: 'c2', classLabel: 'Yin · Wed 7 Oct 09:00' },
      ],
    });
    render(<SyncStatus owner="account-1" />);
    expect(
      screen.getByText('Saved after Hatha · Tue 6 Oct 18:00 finished — the payment requests already sent stay as they are.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Saved after Yin · Wed 7 Oct 09:00 finished — the payment requests already sent stay as they are.'),
    ).toBeInTheDocument();
    const dismiss = screen.getByRole('button', { name: 'Dismiss: Yin · Wed 7 Oct 09:00' });
    expect(dismiss).toHaveAttribute('data-offline-writable');
    act(() => dismiss.click());
    expect(dismissNote).toHaveBeenCalledWith('account-1', 'c2');
  });

  it('says nothing for confirmed statuses alone', () => {
    snapshot.current = snap({ confirmed: { r1: { target: 'attended', confirmedAt: 1 } } });
    const { container } = render(<SyncStatus owner="account-1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
