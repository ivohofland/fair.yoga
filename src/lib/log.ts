/**
 * Structured server-side logging. JSON to stdout in production (Docker
 * captures it; grep/jq-able on the VPS), pretty-printed in development.
 *
 * Usage: `log.error({ err, classId }, 'completion failed')` — put the
 * error under the `err` key so pino serializes stack traces properly.
 * Client components keep using console.* (this module is server-only).
 */

import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined, // drop pid/hostname noise — single process, single host
  ...(process.env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
