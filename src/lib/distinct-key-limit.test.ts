import { describe, it, expect } from 'vitest';
import { checkDistinctKeyLimit } from './distinct-key-limit';

const HOUR = 3_600_000;
let n = 0;
const ip = () => `198.51.100.${n++}`;

describe('checkDistinctKeyLimit', () => {
  it('allows ten distinct keys and refuses the eleventh', () => {
    const a = ip();
    for (let i = 0; i < 10; i++) expect(checkDistinctKeyLimit(a, `k${i}`, 1000).allowed).toBe(true);
    const refused = checkDistinctKeyLimit(a, 'k10', 1000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts a repeated key once', () => {
    const a = ip();
    for (let i = 0; i < 50; i++) expect(checkDistinctKeyLimit(a, 'same', 1000 + i).allowed).toBe(true);
    for (let i = 0; i < 9; i++) expect(checkDistinctKeyLimit(a, `k${i}`, 2000).allowed).toBe(true);
    expect(checkDistinctKeyLimit(a, 'k9', 2000).allowed).toBe(false);
  });

  it('keeps a key already seen allowed after the budget is spent', () => {
    const a = ip();
    for (let i = 0; i < 10; i++) checkDistinctKeyLimit(a, `k${i}`, 1000);
    expect(checkDistinctKeyLimit(a, 'k3', 1500).allowed).toBe(true);
  });

  it('frees the window after an hour', () => {
    const a = ip();
    for (let i = 0; i < 10; i++) checkDistinctKeyLimit(a, `k${i}`, 1000);
    expect(checkDistinctKeyLimit(a, 'new', 1000 + HOUR).allowed).toBe(false);
    expect(checkDistinctKeyLimit(a, 'new', 1001 + HOUR).allowed).toBe(true);
  });

  it('keeps one IP independent of another', () => {
    const a = ip();
    const b = ip();
    for (let i = 0; i < 10; i++) checkDistinctKeyLimit(a, `k${i}`, 1000);
    expect(checkDistinctKeyLimit(b, 'k0', 1000).allowed).toBe(true);
  });
});
