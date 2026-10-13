import { z } from 'zod';

/**
 * Registers zod's English messages. Zod does this itself with a top-level
 * `config(en())`, but declares `sideEffects: false`, so a bundler may drop the
 * call — Next 16.4's does, and every message then reads "Invalid input". The
 * config lives on `globalThis`, so one call per runtime reaches every copy of
 * zod in the bundle.
 */
export function installZodLocale(): void {
  z.config(z.locales.en());
}
