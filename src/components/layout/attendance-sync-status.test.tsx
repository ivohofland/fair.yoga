import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
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

const { startAttendanceSync, stop, syncState, connection } = vi.hoisted(() => {
  const stopFn = vi.fn();
  return {
    stop: stopFn,
    startAttendanceSync: vi.fn(() => stopFn),
    syncState: { needsSignIn: false, retrying: false },
    connection: { offline: false },
  };
});
vi.mock('@/lib/attendance-sync', async (orig) => ({
  ...(await orig<typeof import('@/lib/attendance-sync')>()),
  startAttendanceSync,
  useSyncState: () => syncState,
}));
vi.mock('@/lib/offline-status', () => ({
  useConnectionStatus: () => ({ offline: connection.offline, serverNow: null }),
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
  syncState.retrying = false;
  connection.offline = false;
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('says one change is waiting, singular', async () => {
    await enqueueAttendance(entry());
    renderRegion();
    expect(screen.getByText('1 attendance change waiting to sync')).toBeInTheDocument();
    expect(screen.queryByText(/reloads/)).toBeNull();
  });

  it('does not announce a change that is only waiting on its round trip', async () => {
    await enqueueAttendance(entry());
    renderRegion();
    expect(screen.getByText('1 attendance change waiting to sync')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it.each([
    ['offline', () => (connection.offline = true)],
    ['after an attempt that must be retried', () => (syncState.retrying = true)],
  ])('announces the waiting changes %s', async (_name, arrange) => {
    arrange();
    await enqueueAttendance(entry());
    await enqueueAttendance(entry({ registrationId: 'reg-2' }));
    renderRegion();
    expect(screen.getByRole('status')).toHaveTextContent(/^2 attendance changes waiting to sync\.$/);
  });

  it('keeps one text-only live region mounted, and the text arrives in that same node', async () => {
    await enqueueAttendance(entry());
    renderRegion();
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    expect(region).toHaveClass('sr-only');
    const sent = getOutbox().pending['reg-1'];
    if (!sent) throw new Error('not queued');
    await act(async () => {
      await settleEntry(sent, { kind: 'refused', message: 'Nope' });
    });
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent(/^1 attendance change couldn't be recorded\.$/);
    expect(region.children).toHaveLength(0);
  });

  it('says the device cannot keep pending changes when storage fell back to memory', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    await enqueueAttendance(entry());
    renderRegion();
    expect(
      screen.getByText("1 attendance change waiting to sync. This device can't keep them if the page reloads."),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('announces that the device cannot keep them along with the waiting changes', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    connection.offline = true;
    await enqueueAttendance(entry());
    renderRegion();
    expect(screen.getByRole('status')).toHaveTextContent(
      /^1 attendance change waiting to sync\. This device can't keep them if the page reloads\.$/,
    );
  });

  it('says nothing about the device when storage fell back to memory with nothing pending', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    await enqueueAttendance(entry({ ownerId: 'acct-2' }));
    renderRegion();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('says nothing about the device when only another account’s pending changes are in memory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await enqueueAttendance(entry());
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (value.includes('"reg-2"')) throw new DOMException('quota', 'QuotaExceededError');
      realSetItem.call(this, key, value);
    });
    await enqueueAttendance(entry({ ownerId: 'acct-2', registrationId: 'reg-2' }));
    renderRegion();
    expect(screen.getByText('1 attendance change waiting to sync')).toBeInTheDocument();
    expect(screen.queryByText(/reloads/)).toBeNull();
  });

  it('tells a mounted region when storage falls back to memory', async () => {
    await enqueueAttendance(entry());
    renderRegion();
    expect(screen.queryByText(/reloads/)).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    await act(async () => {
      await enqueueAttendance(entry({ registrationId: 'reg-2' }));
    });
    expect(
      screen.getByText("2 attendance changes waiting to sync. This device can't keep them if the page reloads."),
    ).toBeInTheDocument();
  });

  it('says several are waiting, plural', async () => {
    await enqueueAttendance(entry());
    await enqueueAttendance(entry({ registrationId: 'reg-2' }));
    renderRegion();
    expect(screen.getByText('2 attendance changes waiting to sync')).toBeInTheDocument();
  });

  it('appends the sign-in prompt when sync needs one', async () => {
    syncState.needsSignIn = true;
    await enqueueAttendance(entry());
    renderRegion();
    expect(screen.getByText('1 attendance change waiting to sync — sign in to sync them')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      /^1 attendance change waiting to sync — sign in to sync them\.$/,
    );
  });

  it("does not count or show another owner's entries", async () => {
    await enqueueAttendance(entry({ ownerId: 'acct-2' }));
    await refuse({ ownerId: 'acct-2', registrationId: 'reg-9' });
    renderRegion();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.queryByText(/Couldn't record/)).toBeNull();
  });

  it('shows a refusal in the server words, and Dismiss removes it', async () => {
    await refuse({ status: 'late_cancel' }, 'Class is closed');
    renderRegion();
    expect(screen.getByText("Couldn't record Asha as cancelled late: Class is closed")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open class for Asha' })).toHaveAttribute('href', '/class/class-1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dismiss: Couldn't record Asha/ }));
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

  it('keeps a refusal hidden until every inline consumer of its class has unmounted', async () => {
    await refuse();
    const both = (
      <AttendanceSyncProvider ownerId="acct-1">
        <Consumer classId="class-1" />
        <Consumer classId="class-1" />
        <AttendanceSyncStatus />
      </AttendanceSyncProvider>
    );
    const { rerender } = render(both);
    expect(screen.queryByText(/Couldn't record/)).toBeNull();
    rerender(
      <AttendanceSyncProvider ownerId="acct-1">
        <Consumer classId="class-1" />
        <AttendanceSyncStatus />
      </AttendanceSyncProvider>,
    );
    expect(screen.queryByText(/Couldn't record/)).toBeNull();
    rerender(
      <AttendanceSyncProvider ownerId="acct-1">
        <AttendanceSyncStatus />
      </AttendanceSyncProvider>,
    );
    expect(screen.getByText(/Couldn't record Asha/)).toBeInTheDocument();
  });

  it('gives each refusal its own accessible Dismiss and Open class names, outside any live region', async () => {
    renderRegion();
    await act(async () => {
      await refuse({ registrationId: 'reg-1', studentName: 'Asha' });
      await refuse({ registrationId: 'reg-2', studentName: 'Ben' });
    });
    const controls = [
      screen.getByRole('button', { name: /^Dismiss: Couldn't record Asha/ }),
      screen.getByRole('button', { name: /^Dismiss: Couldn't record Ben/ }),
      screen.getByRole('link', { name: 'Open class for Asha' }),
      screen.getByRole('link', { name: 'Open class for Ben' }),
    ];
    for (const control of controls) {
      expect(control.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    }
    expect(within(screen.getByRole('status')).queryAllByRole('button')).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent(/^2 attendance changes couldn't be recorded\.$/);
  });

  it('moves focus to the next refusal\'s Dismiss, and after the last to the block', async () => {
    await refuse({ registrationId: 'reg-1', studentName: 'Asha' });
    await refuse({ registrationId: 'reg-2', studentName: 'Ben' });
    renderRegion();
    const first = screen.getByRole('button', { name: /^Dismiss: Couldn't record Asha/ });
    first.focus();
    await act(async () => {
      fireEvent.click(first);
    });
    const second = screen.getByRole('button', { name: /^Dismiss: Couldn't record Ben/ });
    expect(second).toHaveFocus();
    await act(async () => {
      fireEvent.click(second);
    });
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).toBeNull();
    expect(screen.getByRole('group', { name: 'Attendance sync' })).toHaveFocus();
  });

  it('gives Open class and Dismiss full-height tap targets', async () => {
    await refuse();
    renderRegion();
    expect(screen.getByRole('link', { name: 'Open class for Asha' })).toHaveClass('min-h-11');
    expect(screen.getByRole('button', { name: /^Dismiss: / })).toHaveClass('min-h-11');
  });

  it('shows a refusal for a class that has no inline consumer', async () => {
    await refuse();
    renderRegion(<Consumer classId="class-other" />);
    expect(screen.getByText(/Couldn't record Asha/)).toBeInTheDocument();
  });

  it('shows a refusal stored when the layout mounted without announcing it', async () => {
    await refuse();
    renderRegion();
    expect(screen.getByText(/Couldn't record Asha/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('announces a refusal that arrives after mount, and keeps that text as other things change', async () => {
    renderRegion();
    await act(async () => {
      await refuse();
    });
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent(/^1 attendance change couldn't be recorded\.$/);
    await act(async () => {
      await enqueueAttendance(entry({ registrationId: 'reg-2' }));
    });
    expect(region).toHaveTextContent(/^1 attendance change couldn't be recorded\.$/);
  });

  it('does not re-announce the rest when one announced refusal leaves the summary', async () => {
    const { rerender } = renderRegion();
    const region = screen.getByRole('status');
    await act(async () => {
      await refuse({ registrationId: 'reg-1', classId: 'class-1' });
      await refuse({ registrationId: 'reg-2', classId: 'class-2', studentName: 'Ben' });
    });
    expect(region).toHaveTextContent(/^2 attendance changes couldn't be recorded\.$/);
    rerender(
      <AttendanceSyncProvider ownerId="acct-1">
        <Consumer classId="class-1" />
        <AttendanceSyncStatus />
      </AttendanceSyncProvider>,
    );
    expect(screen.getByText(/Couldn't record Ben/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toBeEmptyDOMElement();
  });

  it('does not announce a refusal the class page showed, once the teacher leaves that page', async () => {
    const { rerender } = renderRegion(<Consumer classId="class-1" />);
    const region = screen.getByRole('status');
    await act(async () => {
      await refuse();
    });
    expect(screen.queryByText(/Couldn't record/)).toBeNull();
    // The layout stays mounted across the navigation: same slot, same live region.
    rerender(
      <AttendanceSyncProvider ownerId="acct-1">
        {null}
        <AttendanceSyncStatus />
      </AttendanceSyncProvider>,
    );
    expect(screen.getByText(/Couldn't record Asha/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toBeEmptyDOMElement();
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
