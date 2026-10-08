/**
 * Runs in the browser before the app's own code.
 *
 * The page CSP (`src/lib/csp.ts`) carries no `'unsafe-eval'` in production.
 * Zod probes whether `new Function` is allowed the first time a schema is
 * built; the probe catches its own error, but the browser still reports a
 * `securitypolicyviolation` for it — on every page that builds a schema.
 * `jitless` makes zod skip the probe and its eval-compiled fast path.
 */
import { z } from 'zod'

z.config({ jitless: true })
