import { createMollieClient, type MollieClient } from '@/lib/mollie/client';
import { diagnoseMollieConfig, type MollieConfig } from '@/lib/mollie/config';
import { log } from '@/lib/log';

export type MollieDeps = { client: MollieClient; config: MollieConfig };

let reported = false;
let cached: MollieDeps | null | undefined;

/** Mollie's client and config, or null when Mollie is not configured. Logs the reason once per process. */
export function mollieDeps(): MollieDeps | null {
  if (cached !== undefined) return cached;
  const d = diagnoseMollieConfig();
  if (!d.ok) {
    if (!reported) {
      reported = true;
      if (d.reason === 'unset') log.warn({ reason: d.reason }, 'Mollie is not configured; Mollie payments are off');
      else log.error({ reason: d.reason }, 'Mollie is misconfigured; Mollie payments are off');
    }
    cached = null;
    return null;
  }
  cached = { client: createMollieClient(d.config), config: d.config };
  return cached;
}
