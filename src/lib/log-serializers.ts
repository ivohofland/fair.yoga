/**
 * What an error is allowed to put in a log line (#739). The reasons, and the
 * measurements behind them, are in
 * `docs/superpowers/specs/2026-10-03-err-serializer-allowlist-design.md`.
 *
 * `serializeErr` builds a plain object from named fields only, so a property
 * nobody listed here never reaches a log. A Prisma query error's message is
 * withheld outright: Prisma renders the call's arguments and Postgres's
 * `DETAIL` into it, and both carry row values. What survives of it is the
 * operation and the identifiers lifted below.
 */
import { Prisma } from '@prisma/client';

export interface SerializedPrismaMeta {
  target?: string | string[];
  constraint?: string | string[];
  modelName?: string | string[];
  connection_limit?: number;
  timeout?: number;
}

export interface SerializedErr {
  type: string;
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
  meta?: SerializedPrismaMeta;
  sqlState?: string;
  constraint?: string;
  cause?: SerializedErr;
  aggregateErrors?: SerializedErr[];
}

/** Which `meta` keys survive, and as what. */
const META_KEYS = {
  target: 'identifiers',
  constraint: 'identifiers',
  modelName: 'identifiers',
  connection_limit: 'number',
  timeout: 'number',
} as const satisfies Record<keyof SerializedPrismaMeta, 'identifiers' | 'number'>;

/** Cause and aggregate nesting share this budget. */
const MAX_DEPTH = 8;

const WITHHELD = '(detail withheld from the log)';
const PRISMA_ERROR_NAME = /^PrismaClient\w+Error$/;
const IDENTIFIER = /^[\w.]+$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
// Anchored at the start: a value inside the message cannot be taken for it.
const HEADER = /^\s*Invalid `([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\))` invocation/;
const PG_CODE = /PostgresError \{ code: "([0-9A-Z]{5})"/;
// Postgres writes this sentence before its DETAIL; on the Unknown path its
// quotes arrive backslash-escaped.
const CONSTRAINT = /violates (?:check|exclusion|foreign key|unique) constraint \\?"([A-Za-z0-9_]+)\\?"/;

/** Outputs of this module, so a second pass returns them unchanged. */
const produced = new WeakSet<object>();

type ErrorLike = object & { message: string };

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string';
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

function prismaClass(err: object): string | null {
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
  return PRISMA_ERROR_NAME.test(type) ? type : null;
}

function identifiers(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return IDENTIFIER.test(value) ? value : undefined;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && IDENTIFIER.test(v))) {
    return value as string[];
  }
  return undefined;
}

function allowedMeta(meta: unknown): SerializedPrismaMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const out: SerializedPrismaMeta = {};
  for (const key of Object.keys(META_KEYS) as (keyof SerializedPrismaMeta)[]) {
    const value = field(meta, key);
    if (META_KEYS[key] === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) Object.assign(out, { [key]: value });
    } else {
      const kept = identifiers(value);
      if (kept !== undefined) Object.assign(out, { [key]: kept });
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function liftSqlState(cls: string, err: object, original: string): string | undefined {
  if (cls === 'PrismaClientUnknownRequestError') return PG_CODE.exec(original)?.[1];
  if (field(err, 'code') === 'P2010') {
    const meta = field(err, 'meta');
    const code = typeof meta === 'object' && meta !== null ? field(meta, 'code') : undefined;
    return typeof code === 'string' && SQLSTATE.test(code) ? code : undefined;
  }
  return undefined;
}

function withheld(cls: string, err: ErrorLike, type: string): SerializedErr {
  const original = err.message;
  const header = HEADER.exec(original);
  const message = header ? `Invalid \`${header[1]}\` invocation ${WITHHELD}` : `Prisma error ${WITHHELD}`;

  // Frames are what follows the exact original header. Never filter lines by
  // shape: a raw-query value can hold a newline and a line that looks like a
  // frame. When the prefix does not match, no frame is kept.
  const stack = field(err, 'stack');
  const name = field(err, 'name');
  const prefix = `${String(name)}: ${original}`;
  const frames = typeof stack === 'string' && stack.startsWith(prefix) ? stack.slice(prefix.length) : '';

  const out: SerializedErr = { type, message, stack: `${type}: ${message}${frames}` };
  const sqlState = liftSqlState(cls, err, original);
  if (sqlState !== undefined) {
    out.sqlState = sqlState;
    // Class 23 only: its message is Postgres's own template, so the first
    // match is the constraint's name and never a quoted value.
    if (sqlState.startsWith('23')) {
      const constraint = CONSTRAINT.exec(original)?.[1];
      if (constraint !== undefined) out.constraint = constraint;
    }
  }
  const meta = allowedMeta(field(err, 'meta'));
  if (meta !== undefined) out.meta = meta;
  return out;
}

function serialize(err: ErrorLike, seen: Set<object>, depth: number): SerializedErr {
  seen.add(err);
  const type = typeOf(err);
  const cls = prismaClass(err);

  let out: SerializedErr;
  if (cls !== null && cls !== 'PrismaClientInitializationError') {
    out = withheld(cls, err, type);
  } else {
    out = { type, message: err.message };
    const stack = field(err, 'stack');
    if (typeof stack === 'string') out.stack = stack;
  }

  if (Object.prototype.hasOwnProperty.call(err, 'name')) {
    const name = field(err, 'name');
    if (typeof name === 'string') out.name = name;
  }
  const code = cls === 'PrismaClientInitializationError' ? field(err, 'errorCode') : field(err, 'code');
  if (typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code))) out.code = code;

  if (depth < MAX_DEPTH) {
    const cause = field(err, 'cause');
    if (isErrorLike(cause) && !seen.has(cause)) out.cause = toSerialized(cause, seen, depth + 1);
    const errors = field(err, 'errors');
    if (Array.isArray(errors)) {
      out.aggregateErrors = errors
        .filter((e): e is ErrorLike => isErrorLike(e) && !seen.has(e))
        .map((e) => toSerialized(e, seen, depth + 1));
    }
  }

  produced.add(out);
  return out;
}

function toSerialized(err: ErrorLike, seen: Set<object>, depth: number): SerializedErr {
  return produced.has(err) ? (err as SerializedErr) : serialize(err, seen, depth);
}

export function serializeErr(value: Error): SerializedErr;
export function serializeErr(value: unknown): unknown;
export function serializeErr(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && produced.has(value)) return value;
  if (!isErrorLike(value)) return value;
  return serialize(value, new Set(), 0);
}
