/**
 * Structured server-side logging. JSON to stdout in production (Docker
 * captures it; grep/jq-able on the VPS), pretty-printed in development.
 *
 * Usage: `log.error({ err, classId }, 'completion failed')` — put the
 * error under the `err` key so pino serializes stack traces properly.
 *
 * `serializeErr` (`log-serializers.ts`) runs on every `Error` at the top
 * level of a log call's first argument (any key, not just `err`), on an
 * `Error` passed as the first argument, on the `err` key whether or not its
 * value is an `Error` instance, and on the `msg` pino falls back to when a
 * call passes no message string. `logMethod` runs before that fallback,
 * which is why the rewrite lives here rather than only in `serializers`.
 * What this does not cover is listed in `docs/technical-architecture.md`
 * (What's Intentionally Left Out).
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
import { serializeErr } from './log-serializers';

/**
 * The log call's arguments with every top-level `Error` in the first one
 * serialized. A shallow copy, because callers keep using what they logged.
 */
function redactLogArgs(args: readonly unknown[]): unknown[] {
  const [first, ...rest] = args;
  if (first instanceof Error) return [{ err: serializeErr(first) }, ...rest];
  if (typeof first !== 'object' || first === null) return [...args];
  let copy: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(first)) {
    if (value instanceof Error) {
      copy ??= { ...first };
      copy[key] = serializeErr(value);
    }
  }
  return copy === null ? [...args] : [copy, ...rest];
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
