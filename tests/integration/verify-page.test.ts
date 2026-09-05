import { describe, it, expect } from 'vitest';
import { BASE_URL, freshIp } from '../helpers';

/**
 * `/verify` must not put the verifying rail in the HTML it serves, where it
 * would be painted before any JavaScript ran (#435, #254).
 *
 * **Which render site this pins depends on how the app under test is being
 * served, and neither mode covers both.** The page has two pre-mount sites —
 * the `<Suspense>` fallback and `VerifyContent`'s fall-through — and the
 * route is prerenderable, so:
 *
 *   - against `next dev` (the local `npm run verify`), the route renders per
 *     request and the fall-through produces this HTML;
 *   - against a build (CI's `test-integration` job builds and serves the
 *     standalone bundle), the route is prerendered and the fallback does.
 *
 * So this file means one thing locally and another on the merge gate. That is
 * worth having — between them the two modes cover both sites — but it is not
 * a substitute for either being pinned somewhere the answer cannot move:
 * `page.test.tsx` covers the fall-through directly, and its suspended-params
 * case covers the fallback.
 *
 * What this file adds that neither can: no component test renders through
 * Next's own server, so only this one sees what actually goes over the wire.
 *
 * Neither constant is exercised here. Effects do not run during a server
 * render, so no timer of the gate's ever arms — the HTML is rail-free because
 * `railVisible` starts false.
 */
describe('GET /verify (the HTML that arrives before hydration)', () => {
  it('carries no verifying rail, only the shell around it', async () => {
    // Deliberately not a real token: nothing about this assertion depends on
    // the verification's outcome, because the HTML under test is produced
    // before the browser has asked for one.
    const res = await fetch(`${BASE_URL}/verify?token=not-a-real-token`, {
      headers: freshIp(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Matched on the heading's own words rather than an imported constant:
    // this file runs in the node environment, and `page.tsx` is a client
    // component. A copy edit there is caught next door, where
    // `page.test.tsx` asserts through the exported `RAIL_HEADING`.
    expect(html).not.toContain('Checking your link');
    expect(html).not.toContain('One moment');

    // The negative assertions would hold just as well for an empty body or an
    // error page, so pin something this response must contain for them to
    // mean what they say: the document, and the `(public)` layout's wordmark,
    // which is what the reader looks at for as long as the rail stays away.
    expect(html).toContain('<title>fair.yoga</title>');
    expect(html).toContain('fair<span');
  });
});
