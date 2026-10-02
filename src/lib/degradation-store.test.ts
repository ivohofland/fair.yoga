import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PREFIX = 'test-store-';
const code = `${PREFIX}${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const { writeDegradationEvent } = await vi.importActual<typeof import('./degradation-store')>(
  './degradation-store',
);

beforeEach(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code } });
});

afterAll(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code } });
  await prisma.$disconnect();
});

describe('writeDegradationEvent', () => {
  it('creates the row with the count, both timestamps and the sample', async () => {
    const at = new Date('2026-10-02T10:00:00.000Z');
    await writeDegradationEvent(prisma, { code, count: 3, at, sample: { tier: 9 } });

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code } });
    expect(row.occurrences).toBe(3);
    expect(row.firstSeenAt).toEqual(at);
    expect(row.lastSeenAt).toEqual(at);
    expect(row.lastNotifiedAt).toBeNull();
    expect(row.sample).toEqual({ tier: 9 });
  });

  it('adds to the count, advances lastSeenAt, keeps firstSeenAt and replaces the sample', async () => {
    const first = new Date('2026-10-02T10:00:00.000Z');
    const second = new Date('2026-10-02T10:05:00.000Z');
    await writeDegradationEvent(prisma, { code, count: 2, at: first, sample: { tier: 9 } });
    await writeDegradationEvent(prisma, { code, count: 4, at: second, sample: { tier: 7 } });

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code } });
    expect(row.occurrences).toBe(6);
    expect(row.firstSeenAt).toEqual(first);
    expect(row.lastSeenAt).toEqual(second);
    expect(row.sample).toEqual({ tier: 7 });
  });

  it('survives two writers racing on a code that has no row yet', async () => {
    const at = new Date('2026-10-02T10:00:00.000Z');
    await Promise.all([
      writeDegradationEvent(prisma, { code, count: 1, at, sample: {} }),
      writeDegradationEvent(prisma, { code, count: 1, at, sample: {} }),
    ]);

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code } });
    expect(row.occurrences).toBe(2);
  });

  it('is refused by the database for a count of zero', async () => {
    await expect(
      writeDegradationEvent(prisma, { code, count: 0, at: new Date(), sample: {} }),
    ).rejects.toThrow();
    expect(await prisma.degradationEvent.count({ where: { code } })).toBe(0);
  });
});
