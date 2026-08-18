import { describe, it, expect } from 'vitest';
import { sameRoomIdentity, findIdentityMatch } from './room-identity';

const base = { address: 'Prinsengracht 42', floor: '2', roomName: 'Studio A' };

describe('sameRoomIdentity', () => {
  it('matches when all three fields are identical', () => {
    expect(sameRoomIdentity(base, { ...base })).toBe(true);
  });

  it('differs on address, on floor, and on roomName independently', () => {
    expect(sameRoomIdentity(base, { ...base, address: 'Keizersgracht 1' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, floor: '3' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, roomName: 'Studio B' })).toBe(false);
  });

  // The two cases below are the point of this file.
  //
  // `Room_public_identity_unique` is a plain btree over three `text` columns
  // with no `citext` and no `lower()`, so Postgres compares them byte for
  // byte. This predicate must do the same. The realistic regression here is
  // not a wrong boolean — it is someone adding `.toLowerCase()` or `.trim()`
  // to make matching "more helpful". Every test above passes against that
  // version; one of these two fails for each of them — `.toLowerCase()`
  // leaves the whitespace test green, `.trim()` leaves the case test green.
  //
  // A predicate STRICTER than the index refuses a share Postgres would have
  // accepted, and does it invisibly: the teacher is told "already shared"
  // about a room that is neither theirs nor the same. A predicate LOOSER than
  // the index merely lets the write reach the 409 that already exists. Only
  // the second is recoverable, so this one copies the index exactly.
  //
  // Duplicates that differ only by case therefore remain possible. That is
  // pre-existing (#196 chose this key), it is tracked as #260, and the
  // mitigation is the neighbourhood search putting both in front of a human.
  it('treats case variants as different rooms, because the index does', () => {
    expect(sameRoomIdentity(base, { ...base, address: 'prinsengracht 42' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, roomName: 'studio a' })).toBe(false);
  });

  it('treats whitespace variants as different rooms, because the index does', () => {
    expect(sameRoomIdentity(base, { ...base, address: 'Prinsengracht 42 ' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, floor: ' 2' })).toBe(false);
  });
});

describe('findIdentityMatch', () => {
  it('returns the matching candidate', () => {
    const other = { address: 'Prinsengracht 42', floor: '3', roomName: 'Studio A', id: 'b' };
    const hit = { ...base, id: 'a' };
    expect(findIdentityMatch([other, hit], base)).toBe(hit);
  });

  it('returns undefined when only same-street neighbours are present', () => {
    const neighbour = { address: 'Prinsengracht 42', floor: '9', roomName: 'Attic', id: 'c' };
    expect(findIdentityMatch([neighbour], base)).toBeUndefined();
  });

  it('returns undefined for an empty candidate list', () => {
    expect(findIdentityMatch([], base)).toBeUndefined();
  });
});
