import { describe, it, expect } from 'vitest';

// SCRATCH — deliberately failing. Exists only to verify that a red test job
// drives the aggregate `test` context to failure (#321 acceptance #5).
// This branch must never merge; delete it with the branch.
describe('merge gate verification', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2);
  });
});
