import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { resetOutboxForTests, enqueueAttendance, settleEntry, getOutbox } from '@/lib/attendance-outbox';
import type { PendingEntry } from '@/lib/attendance-outbox';
import { resetSyncForTests } from '@/lib/attendance-sync';
import {
  AttendanceSyncProvider,
  AttendanceSyncStatus,
  useInlineRefusals,
  useAttendanceOwner,
  refusalLine,
} from './attendance-sync-status';

const { startAttendanceSync, stop, syncState } = vi.hoisted(() => {
  const stopFn = vi.fn();
  return {
    stop: stopFn,
    startAttendanceSync: vi.fn(() => stopFn),
    syncState: { needsSignIn: false },
  };
});
vi.mock('@/lib/attendance-sync', async (orig) => ({
  ...(await orig<typeof import('@/lib/attendance-sync')>()),
  startAttendanceSync,
  useSyncState: () => syncState,
}));

function entry(over: Partial<Omit<PendingEntry, 'id'>> = {}): Omit<PendingEntry, 'id'> {
  return {
    ownerId: 'acct-1',
    registrationId: 'reg-1',
    classId: 'class-1',
    studentName: 'Asha',
    status: 'attended',
    recordedAt: 1,
    ...over,
  };
}

async function refuse(over: Partial<Omit<PendingEntry, 'id'>> = {}, message = 'Class is closed'): Promise<void> {
  await enqueueAttendance(entry(over));
  const registrationId = over.registrationId ?? 'reg-1';
  const sent = getOutbox().pending[registrationId];
  if (!sent) throw new Error('not queued');
  await settleEntry(sent, { kind: 'refused', message });
}

function Consumer({ classId }: { classId: string }) {
  useInlineRefusals(classId);
  return null;
}

function Owner() {
  return <p data-testid="owner">{String(useAttendanceOwner())}</p>;
}

function renderRegion(consumer?: React.ReactNode) {
  return render(
    <AttendanceSyncProvider ownerId="acct-1">
      {consumer}
      <AttendanceSyncStatus />
    </AttendanceSyncProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetOutboxForTests();
  resetSyncForTests();
  startAttendanceSync.mockClear();
  stop.mockClear();
  syncState.needsSignIn = false;
});

describe('AttendanceSyncProvider', () => {
  it('starts sync with the owner and stops it on unmount', () => {
    const { unmount } = renderRegion();
    expect(startAttendanceSync).toHaveBeenCalledWith('acct-1');
    expect(stop).not.toHaveBeenCalled();
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('exposes the owner, and null outside a provider', () => {
    const { unmount } = render(<Owner />);
    expect(screen.getByTestId('owner')).toHaveTextContent('null');
    unmount();
    render(
      <AttendanceSyncProvider ownerId="acct-1">
        <Owner />
      </AttendanceSyncProvider>,
    );
    expect(screen.getByTestId('owner')).toHaveTextContent('acct-1');
  });
});

describe('AttendanceSyncStatus', () => {
  it('renders nothing when there is nothing pending or refused', () => {
    renderRegion();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says one change is waiting, singular', async () => {
    await enqueueAttendance(entry());
    renderRegion();
    expect(screen.getByRole('status')).toHaveTextContent('1 attendance change waiting to sync');
  });

  it('says several are waiting, plural', async () => {
    await enqueueAttendance(entry());
    await enqueueAttendance(entry({ registrationId: 'reg-2' }));
    renderRegion();
    expect(screen.getByRole('status')).toHaveTextContent('2 attendance changes waiting to sync');
  });

  it('appends the sign-in prompt when sync needs one', async () => {
    syncState.needsSignIn = true;
    await enqueueAttendance(entry());
    renderRegion();
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 attendance change waiting to sync — sign in to sync them',
    );
  });

  it("does not count or show another owner's entries", async () => {
    await enqueueAttendance(entry({ ownerId: 'acct-2' }));
    await refuse({ ownerId: 'acct-2', registrationId: 'reg-9' });
    renderRegion();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/Couldn't record/)).toBeNull();
  });

  it('shows a refusal in the server words, and Dismiss removes it', async () => {
    await refuse({ status: 'late_cancel' }, 'Class is closed');
    renderRegion();
    expect(screen.getByText("Couldn't record Asha as cancelled late: Class is closed")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open class' })).toHaveAttribute('href', '/class/class-1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(screen.queryByText(/Couldn't record/)).toBeNull();
  });

  it('hides a refusal for a class with a mounted inline consumer, and shows it after unmount', async () => {
    await refuse();
    const { rerender } = renderRegion(<Consumer classId="class-1" />);
    expect(screen.queryByText(/Couldn't record/)).toBeNull();
    rerender(
      <AttendanceSyncProvider ownerId="acct-1">
        <AttendanceSyncStatus />
      </AttendanceSyncProvider>,
    );
    expect(screen.getByText(/Couldn't record Asha/)).toBeInTheDocument();
  });

  it('shows a refusal for a class that has no inline consumer', async () => {
    await refuse();
    renderRegion(<Consumer classId="class-other" />);
    expect(screen.getByText(/Couldn't record Asha/)).toBeInTheDocument();
  });

  it('picks up a refusal that arrives after mount', async () => {
    await enqueueAttendance(entry());
    renderRegion();
    const sent = getOutbox().pending['reg-1'];
    if (!sent) throw new Error('not queued');
    await act(async () => {
      await settleEntry(sent, { kind: 'refused', message: 'Nope' });
    });
    expect(screen.getByText("Couldn't record Asha as present: Nope")).toBeInTheDocument();
  });
});

describe('refusalLine', () => {
  it('names each status in words', () => {
    const base = { ...entry(), id: 'e', message: 'm', refusedAt: 1 };
    expect(refusalLine({ ...base, status: 'attended' })).toBe("Couldn't record Asha as present: m");
    expect(refusalLine({ ...base, status: 'no_show' })).toBe("Couldn't record Asha as no-show: m");
    expect(refusalLine({ ...base, status: 'late_cancel' })).toBe("Couldn't record Asha as cancelled late: m");
  });
});
