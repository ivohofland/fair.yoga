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
 * The budget for a server-rendered assertion made after a `page.reload()`.
 *
 * A post-action `router.refresh()` commit can be DROPPED on a loaded runner —
 * the write lands and the repaint never arrives. `teacher-journey.spec.ts`'s
 * publish test carries the #40 investigation and reloads for that reason, and
 * `studio.spec.ts` now does the same: raising this budget to 10 s was tried
 * first and CI still reported `element(s) not found` at the full 10 s, which
 * is what rules out "slow" and leaves "dropped". No timeout fixes a commit
 * that never comes; only re-asking the server does.
 *
 * The budget is still needed after the reload, because the reload itself is
 * what is slow on a loaded runner.
 */
export const SERVER_RENDER_TIMEOUT = { timeout: 10_000 };

/**
 * `page.reload()` that waits for the fresh tree to hydrate.
 *
 * A reload throws hydration away, so a click on the reloaded page has the same
 * lost-click hazard as a click after `goto`. Used unconditionally rather than
 * only where a click follows: the SSE request fires on every teacher page, so
 * waiting costs one round-trip and removes the question.
 */
export async function reloadHydrated(page: Page): Promise<void> {
  const hydrated = hydrationSignal(page);
  await page.reload();
  await hydrated;
}

/**
 * Resolves when a PATCH to `path` comes back OK. Arm before the click.
 *
 * This is the reload's precondition, not a substitute for it: reloading
 * before the write commits would read the old state back and pass for the
 * wrong reason.
 */
export function patchOk(page: Page, path: string): Promise<unknown> {
  return page.waitForResponse(
    (r) => r.url().includes(path) && r.request().method() === 'PATCH' && r.ok(),
  );
}
