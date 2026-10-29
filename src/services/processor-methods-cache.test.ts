import { describe, it, expect, vi } from 'vitest';

describe('processor-methods-cache is process-wide', () => {
  it('forgetOfferedMethods on a fresh copy drops what the first copy cached', async () => {
    vi.resetModules();
    const copyA = await import('./processor-methods-cache');
    vi.resetModules();
    const copyB = await import('./processor-methods-cache');
    expect(copyB).not.toBe(copyA);

    copyA.putOffer('conn_x:EUR:5.00', { kind: 'methods', offered: [], excluded: [] }, Date.now());
    expect(copyA.offerCache.has('conn_x:EUR:5.00')).toBe(true);

    copyB.forgetOfferedMethods('conn_x');
    expect(copyA.offerCache.has('conn_x:EUR:5.00')).toBe(false);
  });
});
