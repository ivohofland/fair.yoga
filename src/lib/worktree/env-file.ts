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

/** `openssl rand -hex 24`'s equivalent — matches DEPLOYMENT.md's production CRON_SECRET recipe. */
export function generateCronSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** True when `envPath`'s CRON_SECRET is missing or blank — the value `.env.example` ships, and what a pre-fix worktree's `.env` still carries. */
export function hasEmptyCronSecret(envPath: string): boolean {
  return !readEnvValue(envPath, 'CRON_SECRET');
}
