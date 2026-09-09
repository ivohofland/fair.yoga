import fs from 'fs';
import crypto from 'crypto';

export function generateEnvContent(templateContent: string, overrides: Record<string, string>): string {
  const lines = templateContent.split('\n');
  const applied = new Set<string>();
  const result = lines.map((line) => {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    const key = match?.[1];
    if (key !== undefined && key in overrides) {
      const value = overrides[key];
      if (value !== undefined) {
        applied.add(key);
        return `${key}="${value}"`;
      }
    }
    return line;
  });

  const remaining = Object.keys(overrides).filter((key) => !applied.has(key));
  if (remaining.length > 0) {
    result.push('');
    for (const key of remaining) {
      const value = overrides[key];
      if (value !== undefined) {
        result.push(`${key}="${value}"`);
      }
    }
  }
  return result.join('\n');
}

export function writeEnvIfMissing(
  envPath: string,
  examplePath: string,
  overrides: Record<string, string>,
): boolean {
  if (fs.existsSync(envPath)) {
    return false;
  }
  const template = fs.readFileSync(examplePath, 'utf8');
  fs.writeFileSync(envPath, generateEnvContent(template, overrides));
  return true;
}

export function readEnvValue(envPath: string, key: string): string | undefined {
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(new RegExp(`^${key}="([^"]*)"`, 'm'));
  return match?.[1];
}

/** The `overrides` keys whose value in the `.env` at `envPath` does not match. */
export function findMismatchedEnvKeys(envPath: string, overrides: Record<string, string>): string[] {
  return Object.entries(overrides)
    .filter(([key, expected]) => readEnvValue(envPath, key) !== expected)
    .map(([key]) => key);
}

/** 24 random bytes, hex-encoded. Production's own recipe is documented in DEPLOYMENT.md. */
export function generateCronSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** True when `envPath`'s CRON_SECRET is absent, empty, or whitespace-only. */
export function hasEmptyCronSecret(envPath: string): boolean {
  return !readEnvValue(envPath, 'CRON_SECRET')?.trim();
}

/** The keys `envPath`'s .env doesn't already match: `overrides`' deterministic keys, plus CRON_SECRET when it's still blank. CRON_SECRET is checked separately from `overrides` because a freshly-random value can never equality-match a previously-stored one — folding it into the same equality check would falsely flag a healthy secret on every run. */
export function findStaleEnvKeys(envPath: string, overrides: Record<string, string>): string[] {
  const mismatched = findMismatchedEnvKeys(envPath, overrides);
  if (hasEmptyCronSecret(envPath)) {
    mismatched.push('CRON_SECRET');
  }
  return mismatched;
}
