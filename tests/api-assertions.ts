import { expect } from 'vitest';
import { API_ERROR_STATUS, type ApiErrorCode } from '@/lib/api-error-codes';

/**
 * A refusal carrying exactly this code, at the status the registry fixes for
 * it. Reads no message: copy is free to change without touching a test.
 */
export async function expectRefusal(res: Response, code: ApiErrorCode): Promise<void> {
  const body = (await res.json()) as { error?: { code?: unknown } };
  expect({ status: res.status, code: body.error?.code }).toEqual({
    status: API_ERROR_STATUS[code],
    code,
  });
}

/** A 200 `outcome: 'unchanged'` answer. Returns its `data`. */
export async function expectUnchanged(res: Response): Promise<unknown> {
  const body = (await res.json()) as { data?: unknown; outcome?: unknown };
  expect({ status: res.status, outcome: body.outcome }).toEqual({
    status: 200,
    outcome: 'unchanged',
  });
  return body.data;
}

/**
 * A success that did the work: this status, no `outcome`, and a `data` to
 * return. A body missing `data` fails here rather than handing the caller an
 * `undefined` it would read a field off further down the test.
 */
export async function expectApplied(res: Response, status: 200 | 201 = 200): Promise<unknown> {
  const body = (await res.json()) as { data?: unknown; outcome?: unknown };
  expect({
    status: res.status,
    outcome: body.outcome,
    hasData: 'data' in body && body.data !== undefined,
  }).toEqual({ status, outcome: undefined, hasData: true });
  return body.data;
}
