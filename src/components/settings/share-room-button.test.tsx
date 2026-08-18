import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { fireEvent, waitFor } from '@testing-library/react';
import { ShareRoomButton } from './share-room-button';

// Hoisted so the assertions below can see the same fn the component calls.
// An inline `refresh: vi.fn()` mints a fresh spy per `useRouter()` call and
// is unassertable — which is why the success path went untested at first.
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const identity = { address: 'Prinsengracht 42', floor: '2', roomName: 'Studio A' };
const PUBLISH_URL = '/api/rooms/mine/publish';

function room(over: Partial<{ id: string; floor: string; roomName: string }> = {}) {
  return {
    id: 'other', venueName: 'Yoga Loft', roomName: 'Studio A',
    address: 'Prinsengracht 42', city: 'Amsterdam', postcode: '1015DX',
    floor: '2', maxCapacity: 20, ...over,
  };
}

function mockSearch(rooms: unknown[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ data: rooms }),
  }) as unknown as typeof fetch;
}

/** Search succeeds with `rooms`; the publish POST answers `publish`. */
function mockSearchThenPublish(rooms: unknown[], publish: { ok: boolean; body?: unknown }) {
  global.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.startsWith('/api/rooms?')) {
      return { ok: true, json: async () => ({ data: rooms }) };
    }
    if (url === PUBLISH_URL && init?.method === 'POST') {
      return { ok: publish.ok, json: async () => publish.body ?? {} };
    }
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
  }) as unknown as typeof fetch;
}

function calls() {
  return (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

function openConfirm() {
  fireEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));
}

beforeEach(() => { vi.restoreAllMocks(); refreshMock.mockClear(); });

describe('ShareRoomButton', () => {
  it('offers the confirm when nothing is shared at the address', async () => {
    mockSearch([]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    fireEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));

    expect(await screen.findByText(/Sharing a room is permanent/)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Share room$/ })).toBeDefined();
  });

  // The fixture below carries BOTH a neighbour and an exact match on purpose.
  // A fixture with only the exact match would pass equally against code that
  // blocks on ANY search result, and could not tell the two behaviours apart.
  it('warns but still allows when only a same-street neighbour is shared', async () => {
    mockSearch([room({ id: 'neighbour', floor: '9', roomName: 'Attic' })]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    fireEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));

    expect(await screen.findByText(/Rooms already shared at this address/)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Share room$/ })).toBeDefined();
  });

  it('removes the confirm entirely on an exact identity match', async () => {
    mockSearch([
      room({ id: 'neighbour', floor: '9', roomName: 'Attic' }),
      room({ id: 'exact' }),
    ]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    fireEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));

    expect(await screen.findByText(/Already shared/)).toBeDefined();
    // Absent, not disabled — there is no state that would enable it.
    expect(screen.queryByRole('button', { name: /^Share room$/ })).toBeNull();
  });

  // A failed pre-check must not read as an all-clear. `matches: []` renders
  // the same screen as a genuinely empty address, so without this line the
  // teacher cannot tell "nothing here" from "could not look". The action
  // stays available either way — the route is the authority, not this check.
  it('says so when the duplicate check could not run, and still offers the confirm', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    openConfirm();

    expect(await screen.findByText(/Could not check for rooms already shared/)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Share room$/ })).toBeDefined();
  });

  // The three cases above all stop at the pre-check. These two run the
  // mutation the component exists to perform.
  it('posts to the publish route and refreshes on success', async () => {
    mockSearchThenPublish([], { ok: true });
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: /^Share room$/ }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());

    const publishCall = calls().find(([url]) => String(url) === PUBLISH_URL);
    expect(publishCall).toBeDefined();
    expect((publishCall![1] as { method: string }).method).toBe('POST');
  });

  // The pre-check found nothing and the route refused anyway — the stale
  // snapshot the component's docblock says it will not gate on. The route's
  // message has to reach the teacher, because it is the only account of what
  // went wrong, and the page must not refresh the reason away.
  it('surfaces the route refusal when the pre-check missed a duplicate', async () => {
    mockSearchThenPublish([], {
      ok: false,
      body: {
        error: { code: 'DUPLICATE_ROOM', message: 'A shared room at this address already exists' },
      },
    });
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: /^Share room$/ }));

    expect(
      await screen.findByText('A shared room at this address already exists'),
    ).toBeDefined();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
