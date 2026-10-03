import type { Page, Request } from '@playwright/test';

type HoldState = 'idle' | 'armed' | 'fetching' | 'holding' | 'released';
interface Hold { target: string | null; state: HoldState; release: (() => void) | null }
type HoldWindow = Window & { __skeletonHold: Hold };

/**
 * Runs in the page. Wraps fetch so the next RSC navigation fetch to the armed
 * path is served as a stream that withholds part of its body until release:
 * under `next dev` the line holding the page's own row (its boundary then
 * suspends and loading.tsx renders); in a production build, where that dev-only
 * marker is absent, the whole body (the prefetched boundary renders). If Next
 * changes either shape, the route's own skeleton never appears — but under
 * `next dev` an ancestor's fallback can still paint with `aria-busy`, so the
 * assertion that catches a broken hold is the first-item anchor's
 * visibility, not the generic `aria-busy` one; the spec cannot pass by
 * comparing the page with itself.
 */
export function installFetchHold(): void {
  const w = window as unknown as HoldWindow;
  w.__skeletonHold = { target: null, state: 'idle', release: null };
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const hold = w.__skeletonHold;
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const isNavigation =
      headers.get('rsc') === '1' && !headers.has('next-router-prefetch') && !headers.has('next-router-segment-prefetch');
    if (hold.state !== 'armed' || url.pathname !== hold.target || !isNavigation) return original(input, init);
    hold.state = 'fetching';
    const response = await original(input, init);
    const text = await response.text();
    let head = '';
    let tail = text;
    const marker = /"type":"page","pagePath":"[^"]*","children":"\$L?([0-9a-f]+)"/.exec(text);
    const row = marker && new RegExp(`(^|\\n)${marker[1]}:[\\[{"]`).exec(text);
    if (row) {
      const start = row.index + (row[1] ? 1 : 0);
      const end = text.indexOf('\n', start) + 1;
      tail = text.slice(start, end);
      head = text.slice(0, start) + text.slice(end);
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (head) controller.enqueue(encoder.encode(head));
        hold.state = 'holding';
        hold.release = () => {
          controller.enqueue(encoder.encode(tail));
          controller.close();
          hold.state = 'released';
        };
      },
    });
    const held = new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
    Object.defineProperty(held, 'url', { value: response.url });
    Object.defineProperty(held, 'redirected', { value: response.redirected });
    return held;
  };
}

/** Points the installed wrapper at the next navigation fetch to `pathname`. */
export async function armHold(page: Page, pathname: string): Promise<void> {
  await page.evaluate((target) => {
    const hold = (window as unknown as HoldWindow).__skeletonHold;
    hold.target = target;
    hold.state = 'armed';
  }, pathname);
}

/** Resolves once the armed fetch has answered and its withheld part is pending. */
export async function waitForHolding(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as HoldWindow).__skeletonHold.state === 'holding');
}

/** Delivers the withheld part, so the navigation completes. */
export async function releaseHold(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { release } = (window as unknown as HoldWindow).__skeletonHold;
    if (!release) throw new Error('releaseHold: nothing is being held');
    release();
  });
}

/** `next dev` mounts its overlay host; a production build does not. */
export async function isDevServer(page: Page): Promise<boolean> {
  return (await page.locator('nextjs-portal').count()) > 0;
}

/**
 * Resolves when the loading-boundary prefetch for `pathname` has settled.
 * Must be called before `page.goto`, since the prefetch may fire during the
 * first load. Settling counts on failure too: that prefetch usually ends
 * `net::ERR_ABORTED` even when its boundary arrived. A production build only:
 * `next dev` never prefetches, so there this never resolves.
 */
export function prefetchSettled(page: Page, pathname: string): Promise<void> {
  return new Promise((resolve) => {
    const onSettled = (request: Request): void => {
      if (new URL(request.url()).pathname !== pathname) return;
      const headers = request.headers();
      if (headers['next-router-prefetch'] !== '1' || 'next-router-segment-prefetch' in headers) return;
      page.off('requestfinished', onSettled);
      page.off('requestfailed', onSettled);
      resolve();
    };
    page.on('requestfinished', onSettled);
    page.on('requestfailed', onSettled);
  });
}
