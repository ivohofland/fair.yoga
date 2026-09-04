import { describe, it, expect } from 'vitest';
import { BASE_URL, freshIp } from '../helpers';

/**
 * What `/verify` puts in its HTML before any JavaScript has run (#435, #254).
 *
 * Until this branch it painted the "Checking your link" rail there — on
 * screen at first paint, before hydration, before the verification request
 * had even been sent, and gone again 89–194ms later.
 *
 * The component suite cannot see this. Its `next/navigation` mock answers
 * synchronously, so nothing suspends and the page is only ever exercised
 * post-mount; `page.tsx`'s two pre-mount render sites are both invisible to
 * it. That is not a guess — restoring either one leaves all 16 of those
 * cases green.
 *
 * **What this file covers, and what it does not.** It fetches from the dev
 * server, where the page is rendered per request and `VerifyContent` is what
 * produces this HTML — so what it pins is `useVerifyingRail`'s gate holding
 * below its threshold. A built deployment serves this route prerendered
 * (`○ /verify` in the build's route table), where a `useSearchParams`
 * bailout means the `<Suspense>` fallback is the first paint instead. That
 * second path has no local test — nothing here runs against a production
 * build — and rests on the fallback rendering `null`.
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

    expect(html).not.toContain('Checking your link');
    expect(html).not.toContain('One moment');

    // The negative assertions above would hold just as well for an empty
    // body or an error page, so pin something this response must contain for
    // them to mean what they say: the document, and the `(public)` layout's
    // wordmark, which is what the reader looks at for as long as the rail
    // stays away. Matched on its markup rather than the word "yoga", which
    // appears in the title of every page in the app.
    expect(html).toContain('<title>fair.yoga</title>');
    expect(html).toContain('fair<span');
  });
});
