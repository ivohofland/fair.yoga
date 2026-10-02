import { vi } from 'vitest';

// A fallback tripped inside an unrelated unit test must not write to the test
// database. The store's own test loads the real module with `importActual`.
vi.mock('@/lib/degradation-store', () => ({
  writeDegradationEvent: vi.fn(async () => undefined),
}));
