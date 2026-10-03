/**
 * Structured server-side logging. JSON to stdout in production (Docker
 * captures it; grep/jq-able on the VPS), pretty-printed in development.
 *
 * Usage: `log.error({ err, classId }, 'completion failed')` — put the
 * error under the `err` key: it is serialized whatever its value, and it is
 * the key pino reads `msg` from when a call passes no message string.
 *
 * `serializeErr` (`log-serializers.ts`) runs, through the `logMethod` hook,
 * on an `Error` passed as the first argument, on every `Error` at the top
 * level of the first argument (any key), and on an error-like value — an
 * object with a string `message` — under `err`. pino copies `err.message`
 * into `msg` after `logMethod` and before any serializer, so rewriting
 * there is what keeps the `msg` fallback redacted. A value that cannot be
 * serialized, or a key that throws when read, is replaced by
 * `UNSERIALIZABLE`; a log call does not throw. What this does not cover is
 * listed in `docs/technical-architecture.md` (What's Intentionally Left
 * Out).
 *
 * This module imports `server-only`, so `next build` fails when any
 * `'use client'` module value-imports it, directly or through any chain
 * of imports. Client code logs with console.*. A client component that
 * needs a type from a module that reaches this one uses `import type`,
 * which erases.
 *
 * Runners outside Next — vitest, Playwright — resolve `server-only` to its
 * throwing default rather than Next's `react-server` condition, so each
 * aliases it to `empty.js` in its own config. A new runner that imports
 * from `src/` needs the same alias.
 */

import 'server-only';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { serializeErr, UNSERIALIZABLE } from './log-serializers';

/**
 * The log call's arguments with every top-level `Error` in the first one,
 * and an error-like value under `err`, serialized. A shallow copy, because
 * callers keep using what they logged. Each key is read and checked in its
 * own `try`: `instanceof` itself throws on a revoked Proxy.
 */
function redactLogArgs(args: readonly unknown[]): unknown[] {
  const [first, ...rest] = args;
  let keys: string[];
  try {
    if (first instanceof Error) return [{ err: serializeErr(first) }, ...rest];
    if (typeof first !== 'object' || first === null) return [...args];
    keys = Object.keys(first);
  } catch {
    return [{ err: UNSERIALIZABLE }, ...rest];
  }
  const source = first as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  let changed = false;
  for (const key of keys) {
    try {
      const value = source[key];
      // `serializeErr` returns a value that is not error-like unchanged, so
      // under `err` only an error-like value is rewritten.
      const redacted = key === 'err' || value instanceof Error ? serializeErr(value) : value;
      copy[key] = redacted;
      if (redacted !== value) changed = true;
    } catch {
      copy[key] = UNSERIALIZABLE;
      changed = true;
    }
  }
  return changed ? [copy, ...rest] : [...args];
}

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined, // drop pid/hostname noise — single process, single host
  serializers: { err: serializeErr },
  hooks: {
    logMethod(args, method) {
      // pino types the hook's args as one overload's parameters; the
      // rewritten list keeps their shape.
      method.apply(this, redactLogArgs(args) as Parameters<typeof method>);
    },
  },
};

/**
 * A destination replaces the transport: pino refuses both at once. Tests pass
 * one to read what the real configuration writes.
 */
export function createLogger(destination?: DestinationStream): Logger {
  if (destination) return pino(options, destination);
  return pino({
    ...options,
    ...(process.env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

export const log = createLogger();
