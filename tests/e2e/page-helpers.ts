import type { Page } from '@playwright/test';

/**
 * Teacher pages: resolve once the LiveUpdates effect opens the SSE stream.
 * Effects run only after hydration, so the request doubles as a reliable
 * "hydration finished" signal. Must be armed before page.goto.
 *
 * `waitForResponse` resolves on response HEADERS, so this says the
 * stream OPENED — never that it stayed open. Do not read it, or a
 * trace, as evidence about the stream's lifetime: a trace's `time`
 * for an unfinished SSE response is the wait for headers, nothing
 * more (`receive: -1`). In the measured trace an open stream reported
 * `time: 18.7ms` — that number is what issue #41 read as the stream
 * dying. Full measurement:
 * docs/superpowers/specs/2026-08-08-sse-stream-liveness-design.md
 *
 * The property this cannot check is checked by
 * `tests/integration/notifications-stream.test.ts`.
 *
 * Good for the first load of a tree only. A client-side navigation within
 * the same layout reuses the connection this waits for and issues no second
 * request, so a waiter armed across one would never resolve.
 */
export function hydrationSignal(page: Page): Promise<unknown> {
  return page.waitForResponse((r) => r.url().includes('/api/notifications/stream'));
}

/**
 * The budget for an assertion that crosses from client state into state only
 * a `router.refresh()` can produce. That commit can be slow — or dropped — on
 * a loaded runner; `teacher-journey.spec.ts`'s publish test carries the #40
 * investigation into it and reloads instead. Both of `studio.spec.ts`'s CI
 * flakes sat on this boundary, where the 5 s default was not enough.
 */
export const REFRESH_TIMEOUT = { timeout: 10_000 };
