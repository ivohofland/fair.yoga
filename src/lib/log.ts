/**
 * Structured server-side logging. JSON to stdout in production (Docker
 * captures it; grep/jq-able on the VPS), pretty-printed in development.
 *
 * Usage: `log.error({ err, classId }, 'completion failed')` — put the
 * error under the `err` key so pino serializes stack traces properly.
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
import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined, // drop pid/hostname noise — single process, single host
  ...(process.env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
