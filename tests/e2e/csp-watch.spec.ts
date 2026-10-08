import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

test.describe.configure({ mode: 'serial' });

/**
 * An inline event handler is refused because a nonce does not authorise
 * attributes. A script element inserted from script is not a stand-in,
 * because 'strict-dynamic' lets a trusted script's insertions run.
 */
async function injectInlineHandler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const holder = document.createElement('div');
    holder.innerHTML = '<img alt="" src="data:," onerror="window.__cspWatchRan = true">';
    document.body.append(holder);
  });
}

test.describe('the CSP watcher records', () => {
  test.use({ cspViolationsAllowed: true });

  test('a blocked inline handler in the default context', async ({ page, cspViolations }) => {
    await page.goto('/login');
    // The report the browser itself sends for the violation below.
    const reported = page.waitForResponse((r) => r.url().endsWith('/api/csp-report'), { timeout: 15_000 });
    await injectInlineHandler(page);
    await expect.poll(() => cspViolations.join('\n')).toContain('script-src-attr');
    expect(cspViolations.join('\n')).toContain('/login');
    await expect.poll(() => cspViolations.some((line) => line.startsWith('console:'))).toBe(true);
    expect((await reported).status()).toBe(204);
  });

  test('a blocked inline handler in a context the test opens itself', async ({ browser, baseURL, cspViolations }) => {
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await page.goto('/login');
      await injectInlineHandler(page);
      await expect.poll(() => cspViolations.join('\n')).toContain('script-src-attr');
    } finally {
      await context.close();
    }
  });

  test('a blocked inline handler on a page from browser.newPage()', async ({ browser, baseURL, cspViolations }) => {
    const page = await browser.newPage({ baseURL });
    try {
      await page.goto('/login');
      await injectInlineHandler(page);
      await expect.poll(() => cspViolations.join('\n')).toContain('script-src-attr');
    } finally {
      await page.context().close();
    }
  });
});

test.describe('the CSP watcher fails', () => {
  // The body asserts nothing, so the only way this test can fail is the
  // watcher's teardown. If it passes, Playwright reports it as an unexpected
  // pass and the run goes red.
  test('a test whose page blocked an inline handler', async ({ page }) => {
    test.fail();
    await page.goto('/login');
    await injectInlineHandler(page);
    await page.waitForTimeout(250);
  });
});
