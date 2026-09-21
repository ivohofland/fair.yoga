import { describe, it, expect } from 'vitest';
import { sameRoomIdentity, findIdentityMatch, normalizeRoomField } from './room-identity';

const base = { address: 'Prinsengracht 42', floor: '2', roomName: 'Studio A' };

describe('normalizeRoomField', () => {
  it('trims leading and trailing whitespace and lowercases', () => {
    expect(normalizeRoomField('  Studio A  ')).toBe('studio a');
  });

  it('handles already-clean strings', () => {
    expect(normalizeRoomField('prinsengracht 42')).toBe('prinsengracht 42');
  });

  it('handles empty strings', () => {
    expect(normalizeRoomField('')).toBe('');
    expect(normalizeRoomField('   ')).toBe('');
  });
});

describe('sameRoomIdentity', () => {
  it('matches when all three fields are identical', () => {
    expect(sameRoomIdentity(base, { ...base })).toBe(true);
  });

  it('differs on address, on floor, and on roomName independently', () => {
    expect(sameRoomIdentity(base, { ...base, address: 'Keizersgracht 1' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, floor: '3' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, roomName: 'Studio B' })).toBe(false);
  });

  // `Room_public_identity_unique` and `Room_private_identity_unique` are
  // expression indexes over `lower(trim(...))` (#260). This predicate mirrors
  // them by normalizing each field with `normalizeRoomField`.
  it('treats case variants as the same room, matching the index', () => {
    expect(sameRoomIdentity(base, { ...base, address: 'prinsengracht 42' })).toBe(true);
    expect(sameRoomIdentity(base, { ...base, roomName: 'studio a' })).toBe(true);
  });

  it('treats whitespace variants as the same room, matching the index', () => {
    expect(sameRoomIdentity(base, { ...base, address: 'Prinsengracht 42 ' })).toBe(true);
    expect(sameRoomIdentity(base, { ...base, floor: ' 2' })).toBe(true);
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
