import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { isolatedSweeps } from './scheduler';

describe('isolatedSweeps', () => {
  it('runs every sweep even when some fail, and rethrows the first error', async () => {
    const ran: string[] = [];
    async function alpha() { ran.push('alpha'); throw new Error('boom-alpha'); }
    async function beta() { ran.push('beta'); }
    async function gamma() { ran.push('gamma'); throw new Error('boom-gamma'); }

    const run = isolatedSweeps('test-job', [alpha, beta, gamma]);
    await expect(run({} as unknown as PrismaClient)).rejects.toThrow('boom-alpha');
    expect(ran).toEqual(['alpha', 'beta', 'gamma']); // none starved by an earlier failure
  });

  it('resolves when all sweeps succeed', async () => {
    const run = isolatedSweeps('test-job', [async () => {}, async () => {}]);
    await expect(run({} as unknown as PrismaClient)).resolves.toBeUndefined();
  });
});
