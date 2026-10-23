import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SyncResult } from '@/services/processor-attempts';

const m = vi.hoisted(() => ({
  syncAttempt: vi.fn(),
  mollieDeps: vi.fn(),
  dbWrite: vi.fn(),
}));

// The route's three imports. The database's writes record a call, so a route
// that wrote anything itself would be seen.
vi.mock('@/lib/db', () => {
  const writes = { update: m.dbWrite, updateMany: m.dbWrite, create: m.dbWrite, upsert: m.dbWrite };
  return { prisma: { marker: 'db', payment: writes, processorPayment: writes, $transaction: m.dbWrite, $executeRaw: m.dbWrite } };
});
vi.mock('@/services/processor-attempts', () => ({ syncAttempt: m.syncAttempt }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps: m.mollieDeps }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { POST } = await import('./route');

const DEPS = { marker: 'deps' };

function request(body: string | null, contentType = 'application/x-www-form-urlencoded'): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/mollie', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    ...(body === null ? {} : { body }),
  });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.mollieDeps.mockReturnValue(DEPS);
});

describe('POST /api/webhooks/mollie', () => {
  it('syncs the attempt the form body names', async () => {
    m.syncAttempt.mockResolvedValue('settled');
    await POST(request('id=tr_x'));
    expect(m.syncAttempt).toHaveBeenCalledWith(expect.objectContaining({ marker: 'db' }), DEPS, 'tr_x');
  });

  it.each<SyncResult>(['settled', 'unchanged', 'paid_twice', 'charged_back', 'status_only', 'unknown'])('answers 200 with no body for %s', async (result) => {
    m.syncAttempt.mockResolvedValue(result);
    const res = await POST(request('id=tr_x'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('answers 503 for unavailable, so Mollie retries', async () => {
    m.syncAttempt.mockResolvedValue('unavailable');
    expect((await POST(request('id=tr_x'))).status).toBe(503);
  });

  it.each([
    ['no body', null],
    ['a body without id', 'foo=bar'],
    ['an empty id', 'id='],
    ['a refund id', 'id=re_abc'],
    ['an id with other characters', 'id=tr_abc%2F..'],
  ])('answers 200 without syncing for %s', async (_label, body) => {
    expect((await POST(request(body))).status).toBe(200);
    expect(m.syncAttempt).not.toHaveBeenCalled();
  });

  it('answers 200 without syncing for a JSON body', async () => {
    expect((await POST(request(JSON.stringify({ id: 'tr_x' }), 'application/json'))).status).toBe(200);
    expect(m.syncAttempt).not.toHaveBeenCalled();
  });

  it('a body claiming paid does not settle: only the id reaches the sync, which fetches the status', async () => {
    m.syncAttempt.mockResolvedValue('unknown');
    await POST(request('id=tr_x&status=paid&amount=10.00'));
    expect(m.syncAttempt.mock.calls).toEqual([[expect.objectContaining({ marker: 'db' }), DEPS, 'tr_x']]);
    expect(m.dbWrite).not.toHaveBeenCalled();
  });
});
