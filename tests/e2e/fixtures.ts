import { test as base, expect, type BrowserContext } from '@playwright/test';

/**
 * The e2e `test`, extended with browser-side log capture. Import `test` and
 * `expect` from here rather than from `@playwright/test`; type-only imports
 * stay on the upstream package.
 *
 * WHY THIS EXISTS. A trace records where a client-side failure stopped and
 * says nothing about why. Class C is the worked example:
 * a click's RSC payload and route chunk both arrived in ~11ms, the transition
 * never committed, and the uploaded trace carried the network timeline, the
 * action log — and no browser output at all to explain it.
 *
 * That silence is PRODUCTION, not a gap in the trace format. Playwright does
 * record `console` entries; a local trace of the same test carries two, and
 * both are development-only (React's DevTools banner and `[HMR] connected`).
 * CI runs `pnpm run start`, so neither exists there and nothing else logs. A
 * page error thrown during a transition therefore reaches no one: the run goes
 * red on a timeout whose cause left no evidence.
 *
 * IT DOES NOT FAIL A TEST ON A CONSOLE ERROR, deliberately. That is a
 * different decision with a much wider blast radius — every third-party warning
 * and every benign `console.error` in a component becomes a red build, and the
 * suite would start failing for reasons unrelated to the change under test.
 * This captures; whether anything should also assert is a question for whoever
 * has measured what the app actually logs.
 *
 * THE ONE EXCEPTION IS A CONTENT-SECURITY-POLICY VIOLATION, which fails the
 * test. Under `'strict-dynamic'` a blocked script means a page that renders but
 * never hydrates (#793).
 * `cspViolationsAllowed` turns that off for a spec that triggers violations on
 * purpose.
 *
 * ATTACHED ONLY WHEN THE TEST DID NOT GET ITS EXPECTED RESULT, so a green run
 * carries no extra weight and a `retries`-driven flake attaches on the attempt
 * that failed — the one worth reading. `auto: true` because a diagnostic that
 * each spec has to remember to arm is one that is missing from the spec that
 * needed it.
 */
const MAX_LINES = 500;
const MAX_CSP_LINES = 20;

/**
 * Whether this Chromium fires `beforeinstallprompt` is not ours to pin: when
 * it does, the install card and row would appear on some runs. A capture
 * listener registered before any spec's own code runs stops the page's own
 * listener from ever seeing the event. Context-level because an init script
 * applies to every page the context opens, not just the one it was armed on.
 */
export async function suppressInstallPromptOn(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.addEventListener('beforeinstallprompt', (event) => event.stopImmediatePropagation(), { capture: true });
  });
}

const CSP_BINDING = '__fairyogaCspViolation';
// The recorder a context currently reports to. The binding and the listener
// are registered once per context and look it up on every line, so a context
// that outlives a test (reused contexts) reports to the current test's.
const recorders = new WeakMap<BrowserContext, (line: string) => void>();

/**
 * Arms `context` to record Content-Security-Policy violations into `record`:
 * the document's `securitypolicyviolation` event (directive, blocked URI,
 * path), and, as a second channel, a console message naming the policy for a
 * violation the document listener does not see. Arming a context again
 * replaces its recorder; the binding, init script and listener are
 * registered once.
 */
export async function watchCspViolations(context: BrowserContext, record: (line: string) => void): Promise<void> {
  const wasArmed = recorders.has(context);
  recorders.set(context, record);
  if (wasArmed) return;
  await context.exposeBinding(CSP_BINDING, (_source, line: string) => recorders.get(context)?.(line));
  await context.addInitScript((binding: string) => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report: unknown = Reflect.get(window, binding);
      if (typeof report === 'function') {
        report(`${event.effectiveDirective} blocked ${event.blockedURI || '(none)'} on ${location.pathname}`);
      }
    });
  }, CSP_BINDING);
  context.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) recorders.get(context)?.(`console: ${message.text()}`);
  });
}

export const test = base.extend<{
  browserLogs: void;
  suppressInstallPrompt: void;
  cspViolationsAllowed: boolean;
  cspViolations: readonly string[];
}>({
  cspViolationsAllowed: [false, { option: true }],
  cspViolations: [
    async ({ page, browser, cspViolationsAllowed }, provide) => {
      // One violation reaches us as an event and as a console message, and a
      // regression repeats per blocked chunk: a line is kept once.
      const seen: string[] = [];
      const kept = new Set<string>();
      const record = (line: string) => {
        if (kept.has(line)) return;
        kept.add(line);
        seen.push(line);
      };
      await watchCspViolations(page.context(), record);
      // Contexts the test opens itself are armed too, for the test's duration.
      const newContext = browser.newContext;
      browser.newContext = async (options) => {
        const context = await newContext.call(browser, options);
        await watchCspViolations(context, record);
        return context;
      };
      try {
        await provide(seen);
      } finally {
        browser.newContext = newContext;
      }
      if (!cspViolationsAllowed) {
        // Capped so a broken page does not bury the failure, and the cap is
        // said aloud: a list cut short without a note reads as the whole list.
        const shown =
          seen.length > MAX_CSP_LINES
            ? [...seen.slice(0, MAX_CSP_LINES), `… ${seen.length - MAX_CSP_LINES} more not shown`]
            : seen;
        expect(shown, 'a page this test visited blocked something under its Content-Security-Policy').toEqual([]);
      }
    },
    { auto: true },
  ],
  suppressInstallPrompt: [
    async ({ page }, use) => {
      await suppressInstallPromptOn(page.context());
      await use();
    },
    { auto: true },
  ],
  browserLogs: [
    async ({ page }, use, testInfo) => {
      const lines: string[] = [];
      const started = Date.now();
      const push = (line: string) => {
        // Bounded so one chatty page cannot produce an attachment nobody can
        // open. The cap is reported rather than applied silently — a truncated
        // log that does not say so reads as a complete one.
        if (lines.length < MAX_LINES) lines.push(`[+${Date.now() - started}ms] ${line}`);
        else if (lines.length === MAX_LINES) lines.push(`… truncated at ${MAX_LINES} lines`);
      };

      page.on('console', (msg) => push(`console.${msg.type()}: ${msg.text()}`));
      // Uncaught exceptions and unhandled rejections. Separate from `console`
      // because in a production build this is the channel a thrown render
      // error actually reaches — nothing logs it first.
      page.on('pageerror', (err) => push(`pageerror: ${err.message}`));

      await use();

      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('browser-logs', {
          body: lines.length ? lines.join('\n') : '(the page produced no console output or page errors)',
          contentType: 'text/plain',
        });
      }
    },
    { auto: true },
  ],
});

export { expect };
