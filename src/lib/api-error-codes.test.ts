import { describe, it, expect } from 'vitest';
import {
  API_ERROR_STATUS,
  isApiErrorCode,
  type ApiErrorCode,
  type CodeWithStatus,
  type StatusOf,
} from './api-error-codes';
import type { Assert, Equals } from './type-pins';

describe('isApiErrorCode', () => {
  it('accepts a registered code', () => {
    expect(isApiErrorCode('NOT_FOUND')).toBe(true);
  });

  it('rejects an unregistered string, including an inherited property name', () => {
    expect(isApiErrorCode('NOT_A_CODE')).toBe(false);
    expect(isApiErrorCode('toString')).toBe(false);
    expect(isApiErrorCode('__proto__')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isApiErrorCode(undefined)).toBe(false);
    expect(isApiErrorCode(404)).toBe(false);
    expect(isApiErrorCode({ code: 'NOT_FOUND' })).toBe(false);
  });
});

describe('API_ERROR_STATUS', () => {
  it('registers each code at a status the app sends', () => {
    const allowed = new Set([400, 403, 404, 409, 500, 503]);
    for (const [code, status] of Object.entries(API_ERROR_STATUS)) {
      expect(allowed.has(status), `${code} → ${status}`).toBe(true);
    }
  });
});

// Structural pins: adding a code never breaks them.
type _conflictCodesAre409 = Assert<Equals<StatusOf<CodeWithStatus<409>>, 409>>;
// The server half. Either half can go hollow — a `CodeWithStatus<S>` nobody
// registers a code for is `never`, not an error — and each half's own pin is
// what notices, since `StatusOf<never>` is `never` rather than `S`. This one
// fires on a partial hollowing too, where only one of its statuses is left
// populated. Why the type narrows this way:
// docs/superpowers/specs/2026-09-17-api-error-contract-design.md §4.3.
type _serverCodesAre500Or503 = Assert<Equals<StatusOf<CodeWithStatus<500 | 503>>, 500 | 503>>;
type _notFoundIs404 = Assert<Equals<StatusOf<'NOT_FOUND'>, 404>>;
// Not `ApiErrorCode extends string`, which stays true once the registry's keys
// widen to `string` and so cannot fail: this asserts the keys are still literal.
type _codesAreNotBareString = Assert<Equals<Equals<ApiErrorCode, string>, false>>;
void 0 as unknown as [
  _conflictCodesAre409,
  _serverCodesAre500Or503,
  _notFoundIs404,
  _codesAreNotBareString,
];
