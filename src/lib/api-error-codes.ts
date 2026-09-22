/**
 * Every machine-readable error code the API sends, each at the one HTTP status
 * it is always sent with. A client compares against `ApiErrorCode`, so a code
 * removed here fails to compile wherever a caller still expects it.
 *
 * Imports nothing: this module is value-imported by client code, so anything
 * it pulled in would ship in the browser bundle.
 *
 * Adding a code: one entry here, at its status; the route sends it with
 * `respondError`, or `respondRefusal` for a refusal read whole off a map; a
 * test asserts it with `expectRefusal`.
 *
 * Full rules: `docs/technical-architecture.md` (The Services Layer → Error
 * responses).
 */
export type ApiErrorStatus = 400 | 403 | 404 | 409 | 500 | 503;

export const API_ERROR_STATUS = {
  ACCOUNT_EXISTS: 409,
  ALREADY_ANSWERED: 409,
  ALREADY_INVITED: 409,
  ALREADY_LATE_CANCELLED: 409,
  ALREADY_LINKED: 409,
  ALREADY_REGISTERED: 409,
  ALREADY_TEACHER: 409,
  CLAIM_NOT_OPEN: 409,
  CLASS_CANCELLED: 409,
  CLASS_FROZEN: 409,
  CLASS_FULL: 409,
  CLASS_NOT_BOOKABLE: 409,
  CLASS_NOT_CANCELLABLE: 409,
  CLASS_NOT_ENDED_YET: 409,
  CLASS_NOT_FULL: 409,
  CLASS_NOT_STARTED: 409,
  CLASS_SCHEDULE_FROZEN: 409,
  CLASS_STARTS_IN_PAST: 409,
  CLASS_TERMINAL: 409,
  CONCURRENT_MODIFICATION: 409,
  CONTACT_CHANGED: 409,
  CONTACT_EMAIL_TAKEN: 409,
  CROSS_FAMILY_CLASS_TEMPLATE_SLOT: 409,
  CROSS_FAMILY_STUDIO_TEMPLATE_SLOT: 409,
  DECLINED: 409,
  DECLINED_IS_PERMANENT: 409,
  DUPLICATE_CLASS_SLOT: 409,
  DUPLICATE_ROOM: 409,
  DUPLICATE_STUDIO_SLOT: 409,
  DUPLICATE_STUDIO_TEMPLATE_SLOT: 409,
  DUPLICATE_TEMPLATE_SLOT: 409,
  ENTRY_SLOT_TAKEN: 409,
  ERASURE_BUSY: 503,
  ERASURE_FAILED: 500,
  ILLEGAL_TRANSITION: 409,
  NO_PROFILE_SOURCE: 409,
  NOT_FOUND: 404,
  NOT_ON_WAITLIST: 409,
  NOT_PENDING: 409,
  NOT_ROOM_CREATOR: 403,
  NOT_YOUR_PROFILE: 403,
  NOW_SHARED: 409,
  ONBOARDING_NOT_SETTLED: 409,
  PARTIAL_ERASURE: 500,
  PARTIAL_ERASURE_BUSY: 503,
  PAYMENT_ALREADY_PAID: 409,
  PAYMENT_SETTLED: 409,
  PAYMENT_WAIVED: 409,
  REGISTRATION_CANCELLED: 409,
  ROOM_ALREADY_LISTED: 409,
  ROOM_ARCHIVED: 409,
  ROOM_IN_USE: 409,
  ROOM_IN_USE_RACE: 409,
  ROOM_NOT_ON_LIST: 400,
  RULE_SLOT_TAKEN: 409,
  SETTINGS_LOCKED: 409,
  SLUG_TAKEN: 409,
  SPOT_TAKEN: 409,
  STUDENT_ERASED: 409,
  STUDIO_CLASS_GENERATED_DATE: 409,
  STUDIO_CLASS_INCOME_RECORD: 409,
  STUDIO_CLASS_PAST_DATE: 409,
  STUDIO_CLASS_REGENERATES: 409,
  STUDIO_TEMPLATE_BUSY: 503,
  STUDIO_TEMPLATE_SLOT_CONFLICT: 409,
  TEACHER_NOT_LINKED: 403,
  TEMPLATE_ARCHIVED: 409,
  TEMPLATE_BUSY: 503,
  TEMPLATE_INSTANCE_DATE_CONFLICT: 409,
  TEMPLATE_SLOT_CONFLICT: 409,
  UNIQUE_CONFLICT: 409,
  WAITLIST_ENTRY_INACTIVE: 409,
  WAITLIST_FROZEN: 409,
} as const satisfies Record<string, ApiErrorStatus>;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export type StatusOf<C extends ApiErrorCode> = (typeof API_ERROR_STATUS)[C];

/** The codes registered at status `S`. */
export type CodeWithStatus<S extends ApiErrorStatus> = {
  [C in ApiErrorCode]: StatusOf<C> extends S ? C : never;
}[ApiErrorCode];

/**
 * A refusal whose status is its code's own. For reason → response maps: each
 * entry is checked on its own, which a `{ status: number; code: ApiErrorCode }`
 * value type cannot do.
 */
export type CodedRefusal = {
  [C in ApiErrorCode]: { readonly code: C; readonly status: StatusOf<C>; readonly message: string };
}[ApiErrorCode];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.hasOwn(API_ERROR_STATUS, value);
}

/**
 * Builds a `CodedRefusal` from a code and a message, deriving `status` from
 * `API_ERROR_STATUS` rather than letting a call site hand-type it beside
 * `code` — the same "derive, don't duplicate" `respondPaymentRefusal` used to
 * be the one place doing before #649/#652 folded every other map onto this.
 *
 * Returns `Extract<CodedRefusal, { code: C }>`, not the bare `CodedRefusal`
 * union — the caller's literal `C` is what a consumer narrows on downstream
 * (a `respondError` coded call site infers `C` from `.code` the same way it
 * would from a hand-typed literal; the widened return type flattened that
 * back to `ApiErrorCode` and broke every one of them). The cast is the one
 * place this function trusts rather than re-derives:
 * `{ code, status: API_ERROR_STATUS[code], message }` is exactly one member
 * of `CodedRefusal`'s distributed union for the literal `C` a caller passes,
 * but TypeScript does not narrow a generic function's return expression that
 * way on its own — the signature is what keeps every call site checked.
 */
export function codedRefusal<C extends ApiErrorCode>(
  code: C,
  message: string,
): Extract<CodedRefusal, { code: C }> {
  return { code, status: API_ERROR_STATUS[code], message } as Extract<CodedRefusal, { code: C }>;
}
