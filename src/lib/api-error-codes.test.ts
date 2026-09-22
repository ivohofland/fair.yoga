import { describe, it, expect } from 'vitest';
import {
  isApiErrorCode,
  codedRefusal,
  type ApiErrorCode,
  type CodedRefusal,
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

describe('codedRefusal', () => {
  it('derives status from the registered code, never taking one as an argument', () => {
    const refusal = codedRefusal('NOT_FOUND', 'This payment no longer exists.');

    expect(refusal).toEqual({
      code: 'NOT_FOUND',
      status: 404,
      message: 'This payment no longer exists.',
    });
  });

  /**
   * Annotated with the ONE member the code names, never the whole
   * `CodedRefusal` union: the union accepts anything the union produces, so a
   * wide annotation here would hold for a `codedRefusal` returning the bare
   * union too, and would pin nothing.
   */
  it("produces a value assignable to its own code's member, not merely to the union", () => {
    const refusal: Extract<CodedRefusal, { code: 'PAYMENT_WAIVED' }> = codedRefusal(
      'PAYMENT_WAIVED',
      'x',
    );
    expect(refusal.status).toBe(409);
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
// `codedRefusal`'s return type is the ONE member `C` names, not the whole
// union — what a consumer narrows on downstream, and what a `respondError`
// coded call site infers `C` from. Two-directional where the assignment in the
// test above is one-directional: this also fails if the return type narrows
// PAST its member (a literal `message`, say), which assigning into that member
// would accept.
type _codedRefusalNarrowsToItsCode = Assert<
  Equals<ReturnType<typeof codedRefusal<'NOT_FOUND'>>, Extract<CodedRefusal, { code: 'NOT_FOUND' }>>
>;
void 0 as unknown as [
  _conflictCodesAre409,
  _serverCodesAre500Or503,
  _notFoundIs404,
  _codesAreNotBareString,
  _codedRefusalNarrowsToItsCode,
];
