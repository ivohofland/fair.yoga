import { describe, expect, it } from 'vitest';
import { joinOrThrow } from '../../tests/lock-order-teardown';

describe('joinOrThrow', () => {
  it('resolves when all promises fulfill', async () => {
    await expect(joinOrThrow(Promise.resolve(1), Promise.resolve('ok'))).resolves.toBeUndefined();
  });

  it('accepts undefined alongside promises', async () => {
    await expect(joinOrThrow(Promise.resolve(1), undefined)).resolves.toBeUndefined();
  });

  it('rethrows the reason when a promise rejects', async () => {
    await expect(
      joinOrThrow(Promise.reject(new Error('boom')), Promise.resolve(1)),
    ).rejects.toThrow('boom');
  });

  it('rethrows the first rejection in array order when multiple reject', async () => {
    const first = new Error('first failure');
    const second = new Error('second failure');
    await expect(joinOrThrow(Promise.reject(first), Promise.reject(second))).rejects.toThrow(
      'first failure',
    );
  });

  it('rethrows a later rejection even when an earlier promise resolves', async () => {
    await expect(
      joinOrThrow(Promise.resolve(1), Promise.reject(new Error('boom')), Promise.resolve(2)),
    ).rejects.toThrow('boom');
  });

  it('waits for all promises to settle before throwing', async () => {
    let secondSettled = false;
    const slow = new Promise<void>((resolve) => {
      setTimeout(() => {
        secondSettled = true;
        resolve();
      }, 50);
    });
    const fastFailing = Promise.reject(new Error('fast boom'));

    await expect(joinOrThrow(fastFailing, slow)).rejects.toThrow('fast boom');
    expect(secondSettled).toBe(true);
  });
});
