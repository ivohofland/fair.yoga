/**
 * `searchPublicRooms` and `searchRoomsByCity` never throw — each returns which
 * way it failed.
 *
 * Their callers branch on `outcome.ok` from event handlers whose promise
 * nothing catches, so totality is the contract under test here, not an
 * implementation detail: a throw would leave a search button stuck on
 * "Searching..." with no error. This file covers the request each function
 * builds, the `http` vs `network` split, and the malformed-but-OK body that
 * is deliberately reported as `network`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchPublicRooms, searchRoomsByCity } from './room-search';

function stubFetch(impl: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    // A body that parses but has the wrong shape throws nothing, so there is no error to log.
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

function stubFetchOk(body: unknown) {
  stubFetch(async () => ({ ok: true, json: async () => body }));
}

function stubFetchStatus(status: number) {
  stubFetch(async () => ({ ok: false, status, json: async () => ({}) }));
}

describe('searchRoomsByCity', () => {
  it('asks for the trimmed city and q', async () => {
    stubFetchOk({ data: { rooms: [], truncated: false } });
    await searchRoomsByCity('  Zürich ', '  Bahnhof ');
    const [url] = vi.mocked(global.fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe('/api/rooms?city=Z%C3%BCrich&q=Bahnhof');
  });

  it('leaves q off when it is blank', async () => {
    stubFetchOk({ data: { rooms: [], truncated: false } });
    await searchRoomsByCity('Utrecht', '   ');
    const [url] = vi.mocked(global.fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe('/api/rooms?city=Utrecht');
  });

  it('returns rooms and truncated', async () => {
    const found = { id: 'r', venueName: 'V', roomName: '', address: 'A 1', city: 'C', postcode: 'P', floor: '', maxCapacity: 5 };
    stubFetchOk({ data: { rooms: [found], truncated: true } });
    expect(await searchRoomsByCity('C', '')).toEqual({ ok: true, rooms: [found], truncated: true });
  });

  it('reports http on a refusal and network on a malformed body', async () => {
    stubFetchStatus(400);
    expect(await searchRoomsByCity('C', '')).toEqual({ ok: false, reason: 'http' });
    stubFetchOk({ data: [] }); // the old bare-array shape is not this endpoint's
    expect(await searchRoomsByCity('C', '')).toEqual({ ok: false, reason: 'network' });
  });
});
