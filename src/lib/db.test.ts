import { describe, it, expect, vi, afterEach } from 'vitest';

describe('process-wide client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('production re-evaluation reuses the process client', async () => {
    const savedGlobal = globalThis.__fairYogaPrisma;
    try {
      globalThis.__fairYogaPrisma = undefined;
      vi.stubEnv('NODE_ENV', 'production');
      vi.resetModules();
      const first = await import('./db');
      vi.resetModules();
      const second = await import('./db');
      // No query runs: the client connects lazily, so neither copy opens a connection.
      // Identity is compared as a boolean: diffing two client proxies overflows the stack.
      expect(second.prisma === first.prisma).toBe(true);
    } finally {
      globalThis.__fairYogaPrisma = savedGlobal;
    }
  });
});
