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

  // Pins WHAT is asked, not merely that something was asked.
  // `searchPublicRooms(postcode, street)` is called here with
  // `(postcode, identity.address)` — two strings of the same type, adjacent,
  // trivially swappable. Swapping them leaves every other test in this file
  // green, because the fetch mock matches on `startsWith('/api/rooms?')` and
  // discards the query string.
  //
  // In production the swap returns nothing for every address: `matches` is
  // always `[]`, `findIdentityMatch` never fires, and the "Already shared"
  // branch — spec §3's whole point, and acceptance criterion 4 — becomes
  // permanently unreachable. It fails OPEN: the teacher sees a clean confirm
  // and shares the duplicate the pre-check existed to stop.
  it('asks the search endpoint for this room\'s own postcode and address', async () => {
    mockSearch([]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    openConfirm();
    await screen.findByText(/Sharing a room is permanent/);

    const [url] = calls().find(([u]) => String(u).startsWith('/api/rooms?')) ?? [];
    expect(String(url)).toBe('/api/rooms?postcode=1015DX&street=Prinsengracht+42');
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

  // A failed pre-check must not read as an all-clear. Rendering it as "no
  // matches" is the same screen a genuinely empty address produces, so the
  // teacher could not tell "nothing here" from "could not look". The action
  // stays available either way — the route is the authority, not this check.
  //
  // The two reasons get different sentences, and the distinction is the
  // point: 'network' means the request never landed, so the write may still
  // succeed. 'http' from this endpoint is realistically a 401 or a 5xx, and
  // the write is about to hit the same wall — promising "sharing still works"
  // there is a false statement about the next action, made without knowing
  // anything about why the current one failed.
  it('says the duplicate check could not run, and still offers the confirm', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    openConfirm();

    expect(await screen.findByText(/Sharing still\s+works/)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Share room$/ })).toBeDefined();
  });

  it('does not promise sharing works when the server refused the check', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    openConfirm();

    expect(await screen.findByText(/You may need to\s+sign in again/)).toBeDefined();
    expect(screen.queryByText(/Sharing still\s+works/)).toBeNull();
    expect(screen.getByRole('button', { name: /^Share room$/ })).toBeDefined();
  });

  // Everything above stops at the pre-check. The cases below run the
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

  // ALREADY_SHARED is the server saying the room is already in the state we
  // asked for, which is not a failure. It is reachable without a second
  // device: a first attempt commits, its response is lost, the teacher sees
  // "Network error", the page never refreshed (refresh is on the success path
  // only), so the button is still there and they press it again.
  //
  // Painting that red tells someone their successful share failed — twice,
  // about a one-way door. Reconcile with the server instead.
  it('treats ALREADY_SHARED as reconcile, not as a red failure', async () => {
    mockSearchThenPublish([], {
      ok: false,
      body: { error: { code: 'ALREADY_SHARED', message: 'This room is already shared' } },
    });
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: /^Share room$/ }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(screen.queryByText('This room is already shared')).toBeNull();
  });

  // A cancelled search is still in flight. Without a request token it lands
  // in the reopened panel, showing an all-clear computed for a session the
  // teacher already abandoned.
  it('discards a search belonging to a cancelled open', async () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => { release = r; });
    global.fetch = vi.fn(async () => {
      await pending;
      return { ok: true, json: async () => ({ data: [room({ id: 'exact' })] }) };
    }) as unknown as typeof fetch;

    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);
    openConfirm();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));

    release(null);
    await waitFor(() => expect(
      screen.getByRole('button', { name: /Share with other teachers/ }),
    ).toBeDefined());

    // The abandoned search must not have written "Already shared" anywhere.
    expect(screen.queryByText(/Already shared/)).toBeNull();
  });
});
