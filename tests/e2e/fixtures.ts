import { test as base, expect } from '@playwright/test';

/**
 * The e2e `test`, extended with browser-side log capture. Import `test` and
 * `expect` from here rather than from `@playwright/test`; type-only imports
 * stay on the upstream package.
 *
 * WHY THIS EXISTS. A trace records where a client-side failure stopped and
 * says nothing about why. Class C is the worked example (`docs/backlog-roadmap.md`):
 * a click's RSC payload and route chunk both arrived in ~11ms, the transition
 * never committed, and the uploaded trace carried the network timeline, the
 * action log — and no browser output at all to explain it.
 *
 * That silence is PRODUCTION, not a gap in the trace format. Playwright does
 * record `console` entries; a local trace of the same test carries two, and
 * both are development-only (React's DevTools banner and `[HMR] connected`).
 * CI runs `npm run start`, so neither exists there and nothing else logs. A
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
 * ATTACHED ONLY WHEN THE TEST DID NOT GET ITS EXPECTED RESULT, so a green run
 * carries no extra weight and a `retries`-driven flake attaches on the attempt
 * that failed — the one worth reading. `auto: true` because a diagnostic that
 * each spec has to remember to arm is one that is missing from the spec that
 * needed it.
 */
const MAX_LINES = 500;

export const test = base.extend<{ browserLogs: void }>({
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
