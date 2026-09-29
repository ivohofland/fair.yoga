/**
 * `searchPublicRooms` never throws — it returns which way it failed.
 *
 * The two callers rely on that: `room-search-step.tsx` has no `try` around
 * the call at all, and `share-room-button.tsx` branches on `outcome.ok` from
 * a click handler whose promise nothing catches. If this function ever throws
 * again, the search button sticks on "Searching..." forever with no error,
 * and the share panel rejects into the void. So totality is the contract
 * under test here, not an implementation detail.
 *
 * The `http` vs `network` distinction is covered end-to-end in
 * `add-room-flow.test.tsx`; this file covers the branches no component test
 * can reach — in particular the malformed-but-OK body, which the module
 * deliberately reports as `network` and which nothing pinned before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchPublicRooms } from './room-search';

function stubFetch(impl: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => { vi.unstubAllGlobals(); });

const room = {
  id: 'r1', venueName: 'Yoga Loft', roomName: 'Studio A',
  address: 'Prinsengracht 42', city: 'Amsterdam', postcode: '1015DX',
  floor: '2', maxCapacity: 20,
};

describe('searchPublicRooms', () => {
  it('sends postcode and street, trimmed, in that order', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: [] }) }));

    await searchPublicRooms('  1015DX  ', '  Prinsengracht 42  ');

    const [url] = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
    expect(String(url)).toBe('/api/rooms?postcode=1015DX&street=Prinsengracht+42');
  });

  it('returns the rooms on a well-formed response', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: [room] }) }));

    const outcome = await searchPublicRooms('1015DX', 'Prinsengracht 42');

    expect(outcome).toEqual({ ok: true, rooms: [room] });
  });

  it('reports http when the server refuses', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }));

    expect(await searchPublicRooms('1015DX', 'X')).toEqual({ ok: false, reason: 'http' });
  });

  it('reports network when the request never lands, and logs why', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = new TypeError('Failed to fetch');
    stubFetch(() => { throw failed; });

    expect(await searchPublicRooms('1015DX', 'X')).toEqual({ ok: false, reason: 'network' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('[room-search-request] request failed', { err: failed });
    consoleError.mockRestore();
  });

  // The branches below are why this file exists. Each one used to produce
  // `{ ok: true, rooms: undefined }` — typed as `RoomResult[]`, so nothing
  // downstream suspected it — and then threw inside a React render, from
  // `results.length` in the search step or `candidates.find` in
  // `findIdentityMatch`. A throw in render is the one failure this module was
  // built to make impossible.
  it.each([
    ['a body with no data key', () => ({})],
    ['a body whose data is null', () => ({ data: null })],
    ['a body whose data is not an array', () => ({ data: { rooms: [] } })],
    ['entries missing the identity fields', () => ({ data: [{ id: 'r1' }] })],
    ['a null entry', () => ({ data: [null] })],
  ])('reports network for %s, rather than an ok with a hole in it', async (_label, makeBody) => {
    stubFetch(async () => ({ ok: true, json: async () => makeBody() }));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await searchPublicRooms('1015DX', 'X');

    expect(outcome).toEqual({ ok: false, reason: 'network' });
    // A wrong shape is the server's answer, not a transport failure.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('reports network for a body that is not JSON, and logs why', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable = new SyntaxError('Unexpected token');
    stubFetch(async () => ({ ok: true, json: async () => { throw unreadable; } }));

    const outcome = await searchPublicRooms('1015DX', 'X');

    expect(outcome).toEqual({ ok: false, reason: 'network' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('[room-search-body] request failed', { err: unreadable });
    consoleError.mockRestore();
  });
});
