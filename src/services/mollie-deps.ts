import { createMollieClient, type MollieClient } from '@/lib/mollie/client';
import { diagnoseMollieConfig, type MollieConfig } from '@/lib/mollie/config';
import { log } from '@/lib/log';

export type MollieDeps = { client: MollieClient; config: MollieConfig };

// per-instance: a log-once flag; a split copy logs the configuration problem once more, and nothing else changes
let reported = false;
// per-instance: memoises a client built from constant env; a split copy builds an identical one
let cached: MollieDeps | null | undefined;

/** Mollie's client and config, or null when Mollie is not configured. Logs the reason once per module instance. */
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

/** The server's Mollie mode, or null when Mollie is not configured: what `payGuidanceForTeacher` reads. */
export function configuredMollieMode(): { testmode: boolean } | null {
  const deps = mollieDeps();
  return deps === null ? null : { testmode: deps.config.testmode };
}
