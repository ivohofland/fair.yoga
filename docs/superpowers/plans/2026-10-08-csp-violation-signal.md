# CSP Violation Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A script blocked by the page CSP fails the e2e suite in CI and leaves a `warn` line in production (#793).

**Architecture:** An auto Playwright fixture arms every browser context a test uses with a `securitypolicyviolation` + console watcher and fails the test at teardown. The page policy gains `report-uri /api/csp-report`, and a small rate-limited route logs a sanitised summary of each report.

**Tech Stack:** Next.js 16 route handler, Playwright fixtures, vitest (unit + integration), pino logger (`@/lib/log`).

**Spec:** `docs/superpowers/specs/2026-10-08-csp-violation-signal-design.md` — read it first; §1 holds the measurements every design choice rests on.

## Global Constraints

- `report-uri` only, never `report-to` (spec §1: Chromium drops `report-uri` when `report-to` is present).
- Accept `application/csp-report` only; anything else 415 `UNSUPPORTED_MEDIA_TYPE`.
- Never log a query string, a URL path of `blocked-uri`, or a raw report field.
- Comment Discipline (CLAUDE.md): no counts or rosters in comments; comments state what is true now.
- TypeScript strict; no `any`, no `as` casts to widen types.
- Every new spec wraps its tests in `test.describe.configure({ mode: 'serial' })` (see `playwright.config.ts`, `workers` comment).
- Integration and e2e run against the worktree app: `pnpm run worktree:up` first; both read `INTEGRATION_BASE_URL` from `.env`.

## Review Focus

1. A test that opens a second context with `browser.newContext()` (or `browser.newPage()`) — a violation there must still fail the test. Pinned in Task 1.
2. A violation that occurs on a page *after* the test's last assertion (lazy chunk) — teardown, not an in-body assertion, must catch it. Pinned by Task 1's enforcement case, whose body asserts nothing.
3. A report whose `document-uri` carries `?token=…` — the token must not reach the log. Pinned in Task 2's unit tests.
4. A report sent chunked (no `Content-Length`) or oversized — refused before the body is read. Pinned in Task 2's integration tests (oversized; the missing-header branch by a unit-level check is not possible through `fetch`, so the mutation step covers it).
5. A cross-site POST to the report route — refused by `withErrorHandler` like any other write. Pinned in Task 2.

---

### Task 1: e2e — a CSP violation fails the test

**Files:**
- Modify: `tests/e2e/fixtures.ts`
- Create: `tests/e2e/csp-watch.spec.ts`

**Interfaces:**
- Produces: in `tests/e2e/fixtures.ts`, `export async function watchCspViolations(context: BrowserContext, record: (line: string) => void): Promise<void>`; test fixtures `cspViolations: readonly string[]` (auto) and option `cspViolationsAllowed: boolean` (default `false`).

- [ ] **Step 1: Write the self-test spec (fails: fixtures don't exist yet)**

`tests/e2e/csp-watch.spec.ts`:

```ts
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

test.describe.configure({ mode: 'serial' });

/** An inline script with no nonce: refused under 'strict-dynamic' whatever trusted script inserts it. */
async function injectUnnoncedScript(page: Page): Promise<void> {
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__cspWatchRan = true';
    document.body.append(script);
  });
}

test.describe('the CSP watcher records', () => {
  test.use({ cspViolationsAllowed: true });

  test('a blocked script in the default context', async ({ page, cspViolations }) => {
    await page.goto('/login');
    await injectUnnoncedScript(page);
    await expect.poll(() => cspViolations.join('\n')).toContain('script-src-elem');
    expect(cspViolations.join('\n')).toContain('/login');
  });

  test('a blocked script in a context the test opens itself', async ({ browser, baseURL, cspViolations }) => {
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await page.goto('/login');
      await injectUnnoncedScript(page);
      await expect.poll(() => cspViolations.join('\n')).toContain('script-src-elem');
    } finally {
      await context.close();
    }
  });

  test('a blocked script on a page from browser.newPage()', async ({ browser, baseURL, cspViolations }) => {
    const page = await browser.newPage({ baseURL });
    try {
      await page.goto('/login');
      await injectUnnoncedScript(page);
      await expect.poll(() => cspViolations.join('\n')).toContain('script-src-elem');
    } finally {
      await page.context().close();
    }
  });
});

test.describe('the CSP watcher fails', () => {
  // The body asserts nothing, so the only way this test can fail is the
  // watcher's teardown. If it passes, Playwright reports it as an unexpected
  // pass and the run goes red.
  test('a test whose page blocked a script', async ({ page }) => {
    test.fail();
    await page.goto('/login');
    await injectUnnoncedScript(page);
    await page.waitForTimeout(250);
  });
});
```

- [ ] **Step 2: Run it, see it fail**

Run: `pnpm exec playwright test csp-watch --project=chromium`
Expected: FAIL — `cspViolationsAllowed` / `cspViolations` are not fixtures.

- [ ] **Step 3: Implement the watcher in `tests/e2e/fixtures.ts`**

Add, beside `suppressInstallPromptOn`:

```ts
const CSP_BINDING = '__fairyogaCspViolation';
const armed = new WeakSet<BrowserContext>();

/**
 * Records every Content-Security-Policy violation in `context`: the
 * document's `securitypolicyviolation` event (directive, blocked URI, path)
 * and any console message naming the policy, which is how a violation
 * outside a document listener's reach is reported. Idempotent per context.
 */
export async function watchCspViolations(context: BrowserContext, record: (line: string) => void): Promise<void> {
  if (armed.has(context)) return;
  armed.add(context);
  await context.exposeBinding(CSP_BINDING, (_source, line: string) => record(line));
  await context.addInitScript((binding: string) => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = Reflect.get(window, binding);
      if (typeof report === 'function') {
        report(`${event.effectiveDirective} blocked ${event.blockedURI || '(none)'} on ${location.pathname}`);
      }
    });
  }, CSP_BINDING);
  context.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) record(`console: ${message.text()}`);
  });
}
```

Extend `test` with an option and an auto fixture (keep `browserLogs` and `suppressInstallPrompt` as they are):

```ts
export const test = base.extend<{
  browserLogs: void;
  suppressInstallPrompt: void;
  cspViolationsAllowed: boolean;
  cspViolations: readonly string[];
}>({
  cspViolationsAllowed: [false, { option: true }],
  cspViolations: [
    async ({ page, browser, cspViolationsAllowed }, use) => {
      const seen: string[] = [];
      const record = (line: string) => seen.push(line);
      await watchCspViolations(page.context(), record);
      // Contexts the test opens itself are armed too, for the test's duration.
      const newContext = browser.newContext;
      browser.newContext = async (options) => {
        const context = await newContext.call(browser, options);
        await watchCspViolations(context, record);
        return context;
      };
      try {
        await use(seen);
      } finally {
        browser.newContext = newContext;
      }
      if (!cspViolationsAllowed) {
        expect(seen, 'a page this test visited blocked something under its Content-Security-Policy').toEqual([]);
      }
    },
    { auto: true },
  ],
  // ...existing suppressInstallPrompt and browserLogs entries unchanged
});
```

Verify, don't assume, that `browser.newPage()` goes through the instance's `newContext` — the third Step 1 case is the check. If it does not, wrap `newPage` the same way.

Update the file's header docblock: it says the fixture "DOES NOT FAIL A TEST ON A CONSOLE ERROR, deliberately". That stays true for console errors in general; add that a CSP violation is the one exception, because under `'strict-dynamic'` a blocked script means a page that renders but never hydrates (#793), and say `cspViolationsAllowed` exists for `csp-watch.spec.ts`, which triggers violations on purpose. Do not count specs or contexts in the comment.

- [ ] **Step 4: Run the self-test, see it pass**

Run: `pnpm exec playwright test csp-watch`
Expected: PASS on both projects (the `test.fail()` case reports as expected-fail).

- [ ] **Step 5: Run the whole e2e suite against the worktree dev server**

Run: `pnpm exec playwright test`
Expected: PASS. Any violation reported here is a real finding or dev noise — record it in the task report verbatim; do not filter it.

- [ ] **Step 6: Prove each guard bites (record exact error text for each, then restore and re-run)**

Commit first (memory: a restore must not eat other edits).

1. Delete the `if (!cspViolationsAllowed) { expect(...) }` block → `csp-watch` goes red: the `test.fail()` case passes unexpectedly.
2. Remove the `browser.newContext = …` wrap → the second and third recording cases time out on `expect.poll`.
3. The acceptance proof: in `src/proxy.ts`, set the *request* header to a policy with a different nonce than the response (`requestHeaders.set('Content-Security-Policy', buildPageCsp(mintNonce(), process.env.NODE_ENV === 'development'))`), curl `/login` on the worktree server to warm it, then run `pnpm exec playwright test landing auth --project=chromium` → red, the failure message listing `script-src-elem` violations.

Restore each; `git status` must be clean afterwards, then re-run `pnpm exec playwright test csp-watch`.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/fixtures.ts tests/e2e/csp-watch.spec.ts
git commit -m "test: a page that blocks a script under its CSP fails the e2e test, in every context the test opens (#793)"
```

---

### Task 2: production — `report-uri` and the report route

**Files:**
- Create: `src/lib/csp-report.ts`, `src/lib/csp-report.test.ts`
- Create: `src/app/api/csp-report/route.ts`
- Create: `tests/integration/csp-report.test.ts`
- Modify: `src/lib/csp.ts`, `src/lib/csp.test.ts`, `src/lib/rate-limit.ts`

**Interfaces:**
- Produces: `CSP_REPORT_PATH = '/api/csp-report'`, `MAX_CSP_REPORT_BYTES = 8 * 1024`, `interface CspReportSummary { directive: string; blockedUri: string; documentPath: string; disposition: 'enforce' | 'report' | 'unknown' }`, `summariseCspReport(body: unknown): CspReportSummary | null` — all from `src/lib/csp-report.ts`. Rate-limit prefix `'csp-report:ip'`.

- [ ] **Step 1: Failing unit tests for the summary — `src/lib/csp-report.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { summariseCspReport } from './csp-report';

const report = (fields: Record<string, unknown>) => ({ 'csp-report': fields });

describe('summariseCspReport', () => {
  it('keeps the directive, the keyword, the path and the disposition', () => {
    expect(
      summariseCspReport(
        report({
          'document-uri': 'https://fair.yoga/verify?token=secret-token',
          'effective-directive': 'script-src-elem',
          'violated-directive': 'script-src-elem',
          'blocked-uri': 'inline',
          disposition: 'enforce',
        }),
      ),
    ).toEqual({ directive: 'script-src-elem', blockedUri: 'inline', documentPath: '/verify', disposition: 'enforce' });
  });

  it('reduces a blocked URL to its scheme and host', () => {
    const s = summariseCspReport(report({ 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example:8443/x.js?k=v' }));
    expect(s?.blockedUri).toBe('https://evil.example:8443');
  });

  it('reduces a non-network URL to its scheme', () => {
    const s = summariseCspReport(report({ 'effective-directive': 'img-src', 'blocked-uri': 'data:image/png;base64,AAAA' }));
    expect(s?.blockedUri).toBe('data:');
  });

  it('falls back to violated-directive, then refuses a report with neither', () => {
    expect(summariseCspReport(report({ 'violated-directive': 'img-src' }))?.directive).toBe('img-src');
    expect(summariseCspReport(report({ 'blocked-uri': 'inline' }))).toBeNull();
  });

  it('refuses a directive that is not a directive name', () => {
    expect(summariseCspReport(report({ 'effective-directive': 'script-src\nforged log line' }))).toBeNull();
  });

  it('marks missing or unparseable fields rather than passing them through', () => {
    expect(summariseCspReport(report({ 'effective-directive': 'img-src', 'document-uri': 'not a url', 'blocked-uri': '%%%', disposition: 'weird' }))).toEqual({
      directive: 'img-src',
      blockedUri: 'other',
      documentPath: 'unknown',
      disposition: 'unknown',
    });
    expect(summariseCspReport(report({ 'effective-directive': 'img-src' }))?.blockedUri).toBe('none');
  });

  it('caps the path', () => {
    const s = summariseCspReport(report({ 'effective-directive': 'img-src', 'document-uri': `https://fair.yoga/${'a'.repeat(1000)}` }));
    expect(s?.documentPath.length).toBe(256);
  });

  it('refuses anything that is not a csp-report object', () => {
    for (const body of [null, 'x', [], {}, { 'csp-report': 'x' }, { 'csp-report': null }]) {
      expect(summariseCspReport(body)).toBeNull();
    }
  });
});
```

Add to `src/lib/csp.test.ts`:

```ts
it('reports violations to the report route, by report-uri only', () => {
  for (const isDev of [true, false]) {
    const csp = buildPageCsp('n', isDev);
    expect(directive(csp, 'report-uri')).toBe('report-uri /api/csp-report');
    expect(directive(csp, 'report-to')).toBeUndefined();
  }
});
```

- [ ] **Step 2: Run them, see them fail**

Run: `pnpm exec vitest run src/lib/csp-report.test.ts src/lib/csp.test.ts`
Expected: FAIL — module not found; `report-uri` undefined.

- [ ] **Step 3: Implement `src/lib/csp-report.ts`**

```ts
/**
 * What the report route logs from a browser's CSP violation report
 * (`application/csp-report`, sent for the page policy's `report-uri`).
 * Every field is reduced before it is logged: a query string can carry a
 * token, and a blocked URL's path is the sender's to choose.
 */
export const CSP_REPORT_PATH = '/api/csp-report';
export const MAX_CSP_REPORT_BYTES = 8 * 1024;

const MAX_PATH = 256;
const DIRECTIVE = /^[a-z-]{1,64}$/;
const KEYWORD = /^[a-z-]{1,32}$/;

export interface CspReportSummary {
  directive: string;
  blockedUri: string;
  documentPath: string;
  disposition: 'enforce' | 'report' | 'unknown';
}

function field(report: Record<string, unknown>, name: string): string | undefined {
  const value = report[name];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blockedOrigin(raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'none';
  if (KEYWORD.test(raw)) return raw;
  try {
    const url = new URL(raw);
    return url.host === '' ? url.protocol : `${url.protocol}//${url.host}`;
  } catch {
    return 'other';
  }
}

function documentPath(raw: string | undefined): string {
  if (raw === undefined) return 'unknown';
  try {
    return new URL(raw).pathname.slice(0, MAX_PATH);
  } catch {
    return 'unknown';
  }
}

/** The loggable summary of a parsed report body, or null when it is not a CSP report. */
export function summariseCspReport(body: unknown): CspReportSummary | null {
  if (!isRecord(body)) return null;
  const report = body['csp-report'];
  if (!isRecord(report)) return null;
  const directive = field(report, 'effective-directive') ?? field(report, 'violated-directive');
  if (directive === undefined || !DIRECTIVE.test(directive)) return null;
  const disposition = field(report, 'disposition');
  return {
    directive,
    blockedUri: blockedOrigin(field(report, 'blocked-uri')),
    documentPath: documentPath(field(report, 'document-uri')),
    disposition: disposition === 'enforce' || disposition === 'report' ? disposition : 'unknown',
  };
}
```

Note `'violated-directive'` in older browsers can carry the whole directive with sources (`"script-src 'self'"`), which `DIRECTIVE` refuses — when it does, fall back is null; acceptable, and the unit test above does not claim otherwise.

In `src/lib/csp.ts`, import `CSP_REPORT_PATH` and append `` `report-uri ${CSP_REPORT_PATH}` `` as the last directive of `buildPageCsp`; extend its docblock with one sentence: violations are reported to that route, `report-uri` and not `report-to` (link `docs/technical-architecture.md`, Content Security Policy).

- [ ] **Step 4: Unit tests pass**

Run: `pnpm exec vitest run src/lib/csp-report.test.ts src/lib/csp.test.ts`
Expected: PASS.

- [ ] **Step 5: Failing integration tests — `tests/integration/csp-report.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { BASE_URL, freshIp } from '../helpers';
import { expectRefusal } from '../api-assertions';

const URL_ = `${BASE_URL}/api/csp-report`;
const REPORT = JSON.stringify({
  'csp-report': {
    'document-uri': `${BASE_URL}/login?token=abc`,
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'inline',
    disposition: 'enforce',
  },
});

function send(body: string, headers: Record<string, string> = {}, ip = freshIp()): Promise<Response> {
  return fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/csp-report', ...ip, ...headers }, body });
}

describe('POST /api/csp-report', () => {
  it('accepts a CSP report with 204', async () => {
    const res = await send(REPORT);
    expect(res.status).toBe(204);
  });

  it('refuses any other content type with 415', async () => {
    await expectRefusal(await send(REPORT, { 'content-type': 'application/json' }), 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses an oversized body with 400', async () => {
    const big = JSON.stringify({ 'csp-report': { 'effective-directive': 'img-src', pad: 'x'.repeat(9000) } });
    expect((await send(big)).status).toBe(400);
  });

  it('refuses a body that is not a report with 400', async () => {
    expect((await send('not json')).status).toBe(400);
    expect((await send(JSON.stringify({ 'csp-report': {} }))).status).toBe(400);
  });

  it('refuses a cross-site report like any other write', async () => {
    await expectRefusal(await send(REPORT, { origin: 'https://evil.example' }), 'CROSS_ORIGIN');
  });

  it('rate-limits one address', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await send(REPORT, {}, ip)).status);
    expect(statuses.slice(0, 60).every((s) => s === 204)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it('is where the page policy sends reports', async () => {
    const res = await fetch(`${BASE_URL}/login`, { headers: freshIp() });
    expect(res.headers.get('content-security-policy')).toContain('report-uri /api/csp-report');
  });
});
```

Run: `pnpm exec vitest run --project integration tests/integration/csp-report.test.ts` → FAIL (404).

- [ ] **Step 6: Implement the route and the prefix**

`src/lib/rate-limit.ts`: add `'csp-report:ip'` to `RateLimitPrefix`, to `PREFIX_CAPACITIES` (`1_000`) and to `IpRateLimitPrefix`.

`src/app/api/csp-report/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { respondError, withErrorHandler } from '@/lib/api-utils';
import { MAX_CSP_REPORT_BYTES, summariseCspReport } from '@/lib/csp-report';
import { log } from '@/lib/log';
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// One broken page load sends a report per blocked script.
const PER_IP_LIMIT = 60;
const WINDOW_MS = 60 * 1000;

/**
 * Where the page CSP's `report-uri` sends violations: one `warn` per report,
 * reduced by `summariseCspReport`. Unauthenticated, so IP rate-limited first.
 * Reads its own body — a browser sends `application/csp-report`, which
 * `parseBody` refuses.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const limit = checkIpRateLimit('csp-report:ip', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'csp-report');
  if (!limit.allowed) return respondRateLimited(limit, 'Too many reports.');

  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/csp-report') {
    return respondError('Send this report as application/csp-report.', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  // A chunked body carries no Content-Length; refusing a missing header
  // refuses it before anything is read.
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_CSP_REPORT_BYTES) {
    return respondError('This is not a CSP report.', 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return respondError('This is not a CSP report.', 400);
  }
  const summary = summariseCspReport(body);
  if (summary === null) return respondError('This is not a CSP report.', 400);

  log.warn({ csp: summary }, 'csp violation');
  return new NextResponse(null, { status: 204 });
});
```

Check `respondError`'s overloads accept `(message, 415, 'UNSUPPORTED_MEDIA_TYPE')` and `(message, 400)` as written; adjust only to what the overloads require.

- [ ] **Step 7: Integration tests pass; the whole suite still passes**

Run: `pnpm exec vitest run --project integration tests/integration/csp-report.test.ts` → PASS.
Run: `pnpm run verify` (against the worktree app) → green. Census tests (e.g. `write-handler-wrap-census.test.ts`) may name the new route; satisfy them rather than exempting it.

- [ ] **Step 8: Prove each guard bites** (commit first; record exact failure text; restore; `git status` clean)

1. `csp.ts`: drop the `report-uri` entry → `csp.test.ts` and the integration "is where the page policy sends reports" case red.
2. Route: remove the content-type check → the 415 case red.
3. Route: remove the content-length check → the oversized case red (warm the route with one curl before re-running).
4. Route: remove the rate-limit check → the rate-limit case red.
5. `csp-report.ts`: return `new URL(raw).pathname + new URL(raw).search` from `documentPath` → the first unit case red; return `raw` from `blockedOrigin` for URLs → the scheme-and-host case red.

- [ ] **Step 9: Measure a real browser report end to end**

With the worktree server running, open `/login` in Playwright Chromium (a throwaway script, not committed), inject an unnonced inline script, and confirm the worktree dev server's log shows one `csp violation` warn with `documentPath: '/login'` and no query string. Record the log line in the task report. (Spec §1 measured `Origin`/`Sec-Fetch-Site` on a toy server; this measures it against `withErrorHandler` itself.)

- [ ] **Step 10: Commit**

```bash
git add src/lib/csp-report.ts src/lib/csp-report.test.ts src/app/api/csp-report/route.ts tests/integration/csp-report.test.ts src/lib/csp.ts src/lib/csp.test.ts src/lib/rate-limit.ts
git commit -m "feat: the page CSP reports violations to a rate-limited route that logs a sanitised warn (#793)"
```

---

### Task 3: docs — where CSP violations surface

**Files:**
- Modify: `docs/technical-architecture.md` (new `### Content Security Policy` section directly before `### Cross-site writes`; the `### Unauthenticated API routes` census)

- [ ] **Step 1: Write the section.** It states: the page policy is per-request nonce + `'strict-dynamic'` (`src/lib/csp.ts`, `src/proxy.ts`); a violation surfaces in two places — CI's e2e suite fails the test (`tests/e2e/fixtures.ts`, `cspViolations`, armed on every context including ones a test opens itself; `csp-watch.spec.ts` pins it), and production logs `warn` `csp violation` from `POST /api/csp-report` with directive, blocked scheme+host or keyword, document path (no query) and disposition. Why `report-uri` and not `report-to`, with the measurement (spec §1). That the route is IP-limited (60/min) and that there is no global log throttle beyond it. That `cspViolationsAllowed` exists only for the watcher's own spec.

- [ ] **Step 2: Re-derive the unauthenticated-routes census** by running the command block in that section verbatim, reading every row, and updating the numbers and the rate-limited list (add `csp-report`). Expected from the current 75 / 11 / 6 / 5: 76 routes, 12 without a session guard, 7 rate-limited, 5 with neither — but write what the command prints, and show the arithmetic in the task report.

- [ ] **Step 3: Commit**

```bash
git add docs/technical-architecture.md
git commit -m "docs: where CSP violations surface, and the report route in the unauthenticated census (#793)"
```
