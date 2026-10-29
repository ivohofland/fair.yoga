/**
 * What an error is allowed to put in a log line (#739). The reasons, and the
 * measurements behind them, are in
 * `docs/superpowers/specs/2026-10-03-err-serializer-allowlist-design.md`.
 *
 * `serializeErr` builds a plain, frozen object from named fields only, so a
 * property nobody listed here never reaches its output. The message of a
 * Prisma query error (every `PrismaClient*Error` but the initialization one),
 * of the pg driver adapter's `DriverAdapterError`, and of the adapter's plain
 * cause object met on its own is withheld outright: Prisma renders the call's
 * arguments into the one, the others are Postgres's primary message, and all
 * can carry row values. What survives of them is the operation and the facets
 * lifted below, read through `pgErrorOf` / `adapterKindOf`, or their
 * `…OfCause` twins for a bare cause object (where those look:
 * `docs/technical-architecture.md`, "Database errors"). A withheld error's
 * cause is walked only when it is an `Error`. An error that throws while
 * being read becomes `UNSERIALIZABLE`; it is never returned raw.
 */
import { Prisma } from '@/lib/prisma-client';
import { TERMINAL_TRIGGER_TAILS } from './api-errors';
import {
  adapterKindOf,
  adapterKindOfCause,
  namesConstraintInMessage,
  pgErrorOf,
  pgErrorOfCause,
  type AdapterKind,
} from './pg-error';

type Identifiers = string | readonly string[];

export interface SerializedPrismaMeta {
  readonly constraint?: Identifiers;
  readonly modelName?: Identifiers;
  readonly column?: Identifiers;
  readonly table?: Identifiers;
  readonly column_name?: Identifiers;
  readonly field_name?: Identifiers;
  readonly relation_name?: Identifiers;
  readonly model_a_name?: Identifiers;
  readonly model_b_name?: Identifiers;
  readonly timeout?: number;
  readonly timeTaken?: number;
}

/** A P2028, told apart by its numeric `meta` only: `expired` carries `timeout` and `timeTaken`. */
export type TxErrorKind = 'expired' | 'other';

export type TerminalTrigger = keyof typeof TERMINAL_TRIGGER_TAILS;

export interface SerializedErr {
  readonly type: string;
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string | number;
  readonly meta?: SerializedPrismaMeta;
  readonly sqlState?: string;
  readonly constraint?: string;
  /** `sqlState`'s name can come from Postgres's message (`namesConstraintInMessage`), and none was found. */
  readonly constraintUnparsed?: true;
  readonly adapterKind?: AdapterKind;
  readonly txError?: TxErrorKind;
  readonly trigger?: TerminalTrigger;
  readonly rowIds?: readonly string[];
  readonly cause?: SerializedErr;
  readonly aggregateErrors?: readonly SerializedErr[];
  /** A cause or aggregate member was omitted because the depth or entry budget ran out. */
  readonly causeTruncated?: true;
  /** A cause or aggregate member was omitted because it is this error or one it is nested in. */
  readonly causeCycle?: true;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Which `meta` keys survive, and as what. */
const META_KEYS = {
  constraint: 'identifiers',
  modelName: 'identifiers',
  column: 'identifiers',
  table: 'identifiers',
  column_name: 'identifiers',
  field_name: 'identifiers',
  relation_name: 'identifiers',
  model_a_name: 'identifiers',
  model_b_name: 'identifiers',
  timeout: 'number',
  timeTaken: 'number',
} as const satisfies Record<keyof SerializedPrismaMeta, 'identifiers' | 'number'>;

type MetaKey = keyof typeof META_KEYS;
type MetaKeyOf<Kind> = { [K in MetaKey]: (typeof META_KEYS)[K] extends Kind ? K : never }[MetaKey];

function isMetaKey(key: string): key is MetaKey {
  return Object.prototype.hasOwnProperty.call(META_KEYS, key);
}

// Each list holds the keys of one tag, so the assignment in `allowedMeta` is
// checked against that tag's field type: a key tagged `identifiers` whose
// field is not `Identifiers` does not compile.
const IDENTIFIER_META_KEYS = Object.keys(META_KEYS)
  .filter(isMetaKey)
  .filter((key): key is MetaKeyOf<'identifiers'> => META_KEYS[key] === 'identifiers');
const NUMBER_META_KEYS = Object.keys(META_KEYS)
  .filter(isMetaKey)
  .filter((key): key is MetaKeyOf<'number'> => META_KEYS[key] === 'number');

/** Read in `TERMINAL_TRIGGER_TAILS`'s own key order, which is the match order. */
const TERMINAL_TRIGGERS = Object.keys(TERMINAL_TRIGGER_TAILS).filter((key): key is TerminalTrigger =>
  Object.prototype.hasOwnProperty.call(TERMINAL_TRIGGER_TAILS, key),
);

/** Cause and aggregate nesting share this budget. */
const MAX_DEPTH = 8;
/**
 * Errors one top-level call puts in its output, counting a repeated error at
 * every position it appears, so a graph that reuses nodes cannot grow the
 * line past this.
 */
const MAX_ENTRIES = 64;
const MAX_ROW_IDS = 3;

const WITHHELD = '(detail withheld from the log)';
const PRISMA_ERROR_NAME = /^PrismaClient\w+Error$/;
const IDENTIFIER = /^[\w.]+$/;
// A Prisma code, or Node's errno / `ERR_*` shape: fixed identifiers, bounded
// in length so an arbitrary string cannot pass for one.
const WITHHELD_CODE = /^(?:P\d{4}|E[A-Z0-9_]{1,63})$/;
const FRAME_LINE = /^\s+at /;
// Anchored at the start: a value inside the message cannot be taken for it.
const HEADER = /^\s*Invalid `([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\))` invocation/;
// The charset a logged constraint name keeps, whatever Postgres quoted.
const CONSTRAINT_NAME = /^[A-Za-z0-9_]+$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Outputs of this module, keyed by themselves, so a second pass returns them
 * unchanged. Every value is frozen before it is added, so what a second pass
 * returns is what the first one built.
 */
// per-instance: an identity map; a copy that missed an output would serialize it again rather than pass it through
const produced = new WeakMap<object, SerializedErr>();
/** How many entries each output spans, itself and everything nested in it. */
// per-instance: an identity map; a copy that missed an output would count it as one entry, as for any value it did not build
const entryCounts = new WeakMap<SerializedErr, number>();

function markProduced<T extends SerializedErr>(out: T, entries: number): T {
  produced.set(out, out);
  entryCounts.set(out, entries);
  return out;
}

/** What replaces an error, or a log value, that throws while being read. */
export const UNSERIALIZABLE: SerializedErr = markProduced(
  Object.freeze({ type: 'Unserializable', message: '(error could not be serialized for the log)' }),
  1,
);

function isErrorLike(value: unknown): value is object {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string';
}

/**
 * The adapter's plain cause object (`{kind, originalCode, originalMessage, …}`),
 * met where something logged it on its own. Not every kind carries a
 * `message`, so it is matched by its own fields, not by `isErrorLike`.
 */
function isAdapterCause(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || value instanceof Error) return false;
  return typeof field(value, 'originalCode') === 'string' || typeof field(value, 'originalMessage') === 'string';
}

/** An `Error` instance whatever its `message`, an error-like object, or the adapter's cause object. */
function isSerializable(value: unknown): value is object {
  return value instanceof Error || isErrorLike(value) || isAdapterCause(value);
}

function field(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key];
}

function typeOf(err: object): string {
  const ctor = field(err, 'constructor');
  if (typeof ctor === 'function' && ctor.name) return ctor.name;
  const name = field(err, 'name');
  return typeof name === 'string' ? name : 'Error';
}

function withheldClass(err: object): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return 'PrismaClientKnownRequestError';
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return 'PrismaClientUnknownRequestError';
  if (err instanceof Prisma.PrismaClientValidationError) return 'PrismaClientValidationError';
  if (err instanceof Prisma.PrismaClientRustPanicError) return 'PrismaClientRustPanicError';
  if (err instanceof Prisma.PrismaClientInitializationError) return 'PrismaClientInitializationError';
  // By name too, so a duplicate package instance or an unknown future class
  // fails closed rather than logging its message verbatim.
  const name = field(err, 'name');
  if (typeof name === 'string' && PRISMA_ERROR_NAME.test(name)) return name;
  const type = typeOf(err);
  if (PRISMA_ERROR_NAME.test(type)) return type;
  // By name only: the adapter's class is never imported here.
  if (field(err, 'name') === 'DriverAdapterError') return 'DriverAdapterError';
  return isAdapterCause(err) ? 'DriverAdapterCause' : null;
}

function identifiers(value: unknown): Identifiers | undefined {
  if (typeof value === 'string') return IDENTIFIER.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    if (items.length > 0 && items.every((v) => typeof v === 'string' && IDENTIFIER.test(v))) {
      return Object.freeze(items.map(String));
    }
  }
  return undefined;
}

function allowedMeta(meta: unknown): SerializedPrismaMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const out: Mutable<SerializedPrismaMeta> = {};
  for (const key of IDENTIFIER_META_KEYS) {
    const kept = identifiers(field(meta, key));
    if (kept !== undefined) out[key] = kept;
  }
  for (const key of NUMBER_META_KEYS) {
    const value = field(meta, key);
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : undefined;
}

// True when `remainder` is a leading newline followed only by lines matching
// `FRAME_LINE`. Shape only: it cannot tell a real frame from text that reads
// `    at …`. It is asked about what follows the stack's `${name}: ${message}`
// prefix, which holds more than frames only when the stack was formatted from
// a longer message than the error now carries — and then the rest of that
// longer message is in it, a raw-query value among it.
function isFrameShape(remainder: string): boolean {
  if (!remainder.startsWith('\n')) return false;
  return remainder.slice(1).split('\n').every((line) => FRAME_LINE.test(line));
}

function txErrorKind(meta: unknown): TxErrorKind {
  if (typeof meta !== 'object' || meta === null) return 'other';
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
  return finite(field(meta, 'timeout')) && finite(field(meta, 'timeTaken')) ? 'expired' : 'other';
}

function withheld(cls: string, err: object, type: string, original: string): Mutable<SerializedErr> {
  const header = HEADER.exec(original);
  const message = header
    ? `Invalid \`${header[1]}\` invocation ${WITHHELD}`
    : cls === 'DriverAdapterError' || cls === 'DriverAdapterCause'
      ? `Driver adapter error ${WITHHELD}`
      : `Prisma error ${WITHHELD}`;

  // Frames are what follows the stack's exact `${name}: ${message}` prefix,
  // kept only when that remainder is empty or passes `isFrameShape`. A prefix
  // match alone is not enough: text appended on the message's own last line
  // would otherwise ride along as "frames".
  const stack = field(err, 'stack');
  const prefix = `${String(field(err, 'name'))}: ${original}`;
  let frames = '';
  if (typeof stack === 'string' && stack.startsWith(prefix)) {
    const remainder = stack.slice(prefix.length);
    if (remainder === '' || isFrameShape(remainder)) frames = remainder;
  }

  const out: Mutable<SerializedErr> = { type, message };
  if (typeof stack === 'string') out.stack = `${type}: ${message}${frames}`;
  const bareCause = cls === 'DriverAdapterCause';
  const pg = bareCause ? pgErrorOfCause(err) : pgErrorOf(err);
  if (pg !== null) {
    out.sqlState = pg.sqlState;
    if (pg.constraint !== undefined && CONSTRAINT_NAME.test(pg.constraint)) out.constraint = pg.constraint;
    // A terminality trigger raises 23514 with one of these tails in Postgres's
    // primary message; a genuine CHECK violation names its constraint there
    // instead. DETAIL is never read, for a tail or a row id.
    if (pg.sqlState === '23514' && pg.constraint === undefined) {
      const trigger = TERMINAL_TRIGGERS.find((key) => pg.message.includes(TERMINAL_TRIGGER_TAILS[key]));
      if (trigger !== undefined) {
        out.trigger = trigger;
        const ids = [...new Set(pg.message.match(UUID) ?? [])].slice(0, MAX_ROW_IDS);
        if (ids.length > 0) out.rowIds = Object.freeze(ids);
      }
    }
    if (pg.constraint === undefined && out.trigger === undefined && namesConstraintInMessage(pg.sqlState)) {
      out.constraintUnparsed = true;
    }
  } else {
    const kind = bareCause ? adapterKindOfCause(err) : adapterKindOf(err);
    if (kind !== undefined) out.adapterKind = kind;
  }
  const meta = allowedMeta(field(err, 'meta'));
  if (meta !== undefined) out.meta = meta;
  return out;
}

/** One top-level call's walk: finished nodes, nodes still being built, entries placed. */
interface Walk {
  readonly memo: Map<object, SerializedErr>;
  readonly inProgress: Set<object>;
  entries: number;
}

function serialize(err: object, walk: Walk, depth: number): SerializedErr {
  const entriesBefore = walk.entries;
  walk.entries += 1;
  const cls = withheldClass(err);
  // The adapter's plain cause has no class of its own; its type says what it is.
  const type = cls === 'DriverAdapterCause' ? cls : typeOf(err);
  const withheldPath = cls !== null && cls !== 'PrismaClientInitializationError';
  const rawMessage = field(err, 'message');
  const original = typeof rawMessage === 'string' ? rawMessage : '';

  let out: Mutable<SerializedErr>;
  if (withheldPath) {
    out = withheld(cls, err, type, original);
  } else {
    out = { type, message: original };
    const stack = field(err, 'stack');
    if (typeof stack === 'string') out.stack = stack;
  }

  if (Object.prototype.hasOwnProperty.call(err, 'name')) {
    const name = field(err, 'name');
    // A withheld error's own name could be any text; only a withheld class name is kept.
    if (typeof name === 'string' && (!withheldPath || PRISMA_ERROR_NAME.test(name) || name === 'DriverAdapterError')) {
      out.name = name;
    }
  }
  const code = cls === 'PrismaClientInitializationError' ? field(err, 'errorCode') : field(err, 'code');
  if (withheldPath) {
    if (typeof code === 'string' && WITHHELD_CODE.test(code)) out.code = code;
    if (code === 'P2028') out.txError = txErrorKind(field(err, 'meta'));
  } else if (typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code))) {
    out.code = code;
  }

  // A node met while still in progress is reachable from itself: omitted,
  // and flagged. One the depth or entry budget has no room for is omitted
  // and flagged too. A withheld error's non-`Error` cause is skipped outright:
  // the adapter's is a plain object carrying Postgres's message.
  const rawCause = field(err, 'cause');
  const cause = withheldPath && !(rawCause instanceof Error) ? undefined : rawCause;
  const errors = field(err, 'errors');
  const members: unknown[] = Array.isArray(errors) ? errors : [];
  walk.inProgress.add(err);
  if (depth < MAX_DEPTH) {
    if (isSerializable(cause)) {
      if (walk.inProgress.has(cause)) out.causeCycle = true;
      else {
        const placed = place(cause, walk, depth + 1);
        if (placed === undefined) out.causeTruncated = true;
        else out.cause = placed;
      }
    }
    const aggregated: SerializedErr[] = [];
    for (const member of members) {
      if (!isSerializable(member)) continue;
      if (walk.inProgress.has(member)) {
        out.causeCycle = true;
        continue;
      }
      const placed = place(member, walk, depth + 1);
      if (placed === undefined) out.causeTruncated = true;
      else aggregated.push(placed);
    }
    if (aggregated.length > 0) out.aggregateErrors = Object.freeze(aggregated);
  } else if (isSerializable(cause) || members.some(isSerializable)) {
    out.causeTruncated = true;
  }
  walk.inProgress.delete(err);

  const done = markProduced(Object.freeze(out), walk.entries - entriesBefore);
  walk.memo.set(err, done);
  return done;
}

/**
 * `value`'s output at this position, or `undefined` when the entry budget
 * has no room for it. A node already finished in this call — or an output of
 * this module — is reused rather than serialized again, so an error reachable
 * many times is serialized once; each position still spends its entries.
 */
function place(value: object, walk: Walk, depth: number): SerializedErr | undefined {
  const done = produced.get(value) ?? walk.memo.get(value);
  const cost = done === undefined ? 1 : (entryCounts.get(done) ?? 1);
  if (walk.entries + cost > MAX_ENTRIES) return undefined;
  if (done === undefined) return serialize(value, walk, depth);
  walk.entries += cost;
  return done;
}

export function serializeErr(value: Error): SerializedErr;
export function serializeErr(value: unknown): unknown;
export function serializeErr(value: unknown): unknown {
  try {
    if (typeof value !== 'object' || value === null) return value;
    const own = produced.get(value);
    if (own !== undefined) return own;
    if (!isSerializable(value)) return value;
    return serialize(value, { memo: new Map(), inProgress: new Set(), entries: 0 }, 0);
  } catch {
    return UNSERIALIZABLE;
  }
}
