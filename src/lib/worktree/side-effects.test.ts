import { describe, it, expect } from 'vitest';
import { isPidAlive } from './side-effects';

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for a pid that does not exist', () => {
    // A pid astronomically unlikely to exist on any real system.
    expect(isPidAlive(999999)).toBe(false);
  });
});
