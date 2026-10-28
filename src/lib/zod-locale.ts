import { z } from 'zod';

/**
 * Registers zod's English messages. Without a locale every message reads
 * "Invalid input". Zod installs English itself when a schema is constructed
 * and no locale is set (colinhacks/zod#5959); this call keeps the locale from
 * depending on that. The config lives on `globalThis`, so one call per runtime
 * reaches every copy of zod in the bundle.
 */
export function installZodLocale(): void {
  z.config(z.locales.en());
}
