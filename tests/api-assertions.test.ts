import { describe, it, expect } from 'vitest';
import { expectRefusal, expectUnchanged, expectApplied } from './api-assertions';

/**
 * These three helpers are how every later task's tests read an API answer, so a
 * helper that passed on a wrong answer would make those suites green for the
 * wrong reason. Each case below therefore comes in both directions: the answer
 * the helper must accept, and the near-misses it must reject.
 */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('expectRefusal', () => {
  it('accepts the code at the status the registry fixes for it', async () => {
    await expectRefusal(json({ error: { code: 'NOT_FOUND', message: 'Gone.' } }, 404), 'NOT_FOUND');
    await expectRefusal(json({ error: { code: 'CLASS_FULL' } }, 409), 'CLASS_FULL');
  });

  it('rejects the right code at the wrong status', async () => {
    await expect(
      expectRefusal(json({ error: { code: 'NOT_FOUND' } }, 409), 'NOT_FOUND'),
    ).rejects.toThrow();
  });

  it('rejects a different code at the right status', async () => {
    await expect(
      expectRefusal(json({ error: { code: 'CLASS_FULL' } }, 404), 'NOT_FOUND'),
    ).rejects.toThrow();
  });

  it('rejects a body carrying no code', async () => {
    await expect(
      expectRefusal(json({ error: { message: 'Gone.' } }, 404), 'NOT_FOUND'),
    ).rejects.toThrow();
  });

  it('rejects a success body', async () => {
    await expect(expectRefusal(json({ data: { id: 'a' } }, 200), 'NOT_FOUND')).rejects.toThrow();
  });

  it('rejects a code at the wrong nesting level', async () => {
    await expect(expectRefusal(json({ code: 'NOT_FOUND' }, 404), 'NOT_FOUND')).rejects.toThrow();
  });
});

describe('expectUnchanged', () => {
  it('accepts the unchanged answer and returns its data', async () => {
    expect(await expectUnchanged(json({ data: { id: 'a' }, outcome: 'unchanged' }, 200))).toEqual({
      id: 'a',
    });
  });

  it('rejects an answer with no outcome', async () => {
    await expect(expectUnchanged(json({ data: { id: 'a' } }, 200))).rejects.toThrow();
  });

  it('rejects a different outcome', async () => {
    await expect(
      expectUnchanged(json({ data: { id: 'a' }, outcome: 'applied' }, 200)),
    ).rejects.toThrow();
  });

  it('rejects the unchanged outcome at 201', async () => {
    await expect(
      expectUnchanged(json({ data: { id: 'a' }, outcome: 'unchanged' }, 201)),
    ).rejects.toThrow();
  });

  it('rejects an outcome nested inside data', async () => {
    await expect(
      expectUnchanged(json({ data: { id: 'a', outcome: 'unchanged' } }, 200)),
    ).rejects.toThrow();
  });
});

describe('expectApplied', () => {
  it('accepts an applied answer and returns its data', async () => {
    expect(await expectApplied(json({ data: { id: 'a' } }, 200))).toEqual({ id: 'a' });
  });

  it('accepts 201 when asked for it', async () => {
    expect(await expectApplied(json({ data: { id: 'a' } }, 201), 201)).toEqual({ id: 'a' });
  });

  it('accepts a null data payload', async () => {
    expect(await expectApplied(json({ data: null }, 200))).toBeNull();
  });

  it('rejects a body carrying an unchanged outcome', async () => {
    await expect(
      expectApplied(json({ data: { id: 'a' }, outcome: 'unchanged' }, 200)),
    ).rejects.toThrow();
  });

  it('rejects 201 asserted at the default 200', async () => {
    await expect(expectApplied(json({ data: { id: 'a' } }, 201))).rejects.toThrow();
  });

  it('rejects 200 asserted at 201', async () => {
    await expect(expectApplied(json({ data: { id: 'a' } }, 200), 201)).rejects.toThrow();
  });

  it('rejects a refusal body', async () => {
    await expect(expectApplied(json({ error: { code: 'NOT_FOUND' } }, 409))).rejects.toThrow();
  });

  it('rejects a success carrying no data', async () => {
    await expect(expectApplied(json({}, 200))).rejects.toThrow();
  });
});
