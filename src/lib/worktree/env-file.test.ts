import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateEnvContent, writeEnvIfMissing, readEnvValue, findMismatchedEnvKeys, generateCronSecret, hasEmptyCronSecret, findStaleEnvKeys } from './env-file';

describe('generateEnvContent', () => {
  it('replaces an existing key in place', () => {
    const template = 'DATABASE_URL="postgresql://old"\nOTHER="keep"';
    const result = generateEnvContent(template, { DATABASE_URL: 'postgresql://new' });
    expect(result).toBe('DATABASE_URL="postgresql://new"\nOTHER="keep"');
  });

  it('appends a key that is not present in the template', () => {
    const template = 'DATABASE_URL="postgresql://old"';
    const result = generateEnvContent(template, { INTEGRATION_BASE_URL: 'http://localhost:3100' });
    expect(result).toBe('DATABASE_URL="postgresql://old"\n\nINTEGRATION_BASE_URL="http://localhost:3100"');
  });

  it('leaves lines with no matching override untouched', () => {
    const template = 'PASSKEY_RP_ID="localhost"';
    const result = generateEnvContent(template, { DATABASE_URL: 'postgresql://new' });
    expect(result).toBe('PASSKEY_RP_ID="localhost"\n\nDATABASE_URL="postgresql://new"');
  });
});

describe('writeEnvIfMissing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-env-test-'));
  const envPath = path.join(dir, '.env');
  const examplePath = path.join(dir, '.env.example');
  fs.writeFileSync(examplePath, 'DATABASE_URL="postgresql://old"');

  afterEach(() => {
    fs.rmSync(envPath, { force: true });
  });

  it('writes .env from the template when it does not exist', () => {
    const wrote = writeEnvIfMissing(envPath, examplePath, { DATABASE_URL: 'postgresql://new' });
    expect(wrote).toBe(true);
    expect(fs.readFileSync(envPath, 'utf8')).toContain('postgresql://new');
  });

  it('never overwrites an existing .env', () => {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://hand-edited"');
    const wrote = writeEnvIfMissing(envPath, examplePath, { DATABASE_URL: 'postgresql://new' });
    expect(wrote).toBe(false);
    expect(fs.readFileSync(envPath, 'utf8')).toBe('DATABASE_URL="postgresql://hand-edited"');
  });
});

describe('readEnvValue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-env-read-test-'));
  const envPath = path.join(dir, '.env');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('reads the value of a key present in the file', () => {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://a"\nOTHER="x"');
    expect(readEnvValue(envPath, 'DATABASE_URL')).toBe('postgresql://a');
  });

  it('returns undefined for a key not present in the file', () => {
    fs.writeFileSync(envPath, 'OTHER="x"');
    expect(readEnvValue(envPath, 'DATABASE_URL')).toBeUndefined();
  });
});

describe('findMismatchedEnvKeys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-env-mismatch-test-'));
  const envPath = path.join(dir, '.env');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('returns no keys when every override already matches', () => {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://a"\nPORT="3100"');
    expect(findMismatchedEnvKeys(envPath, { DATABASE_URL: 'postgresql://a', PORT: '3100' })).toEqual([]);
  });

  it('returns only the keys whose stored value differs from the expected one', () => {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://stale"\nPORT="3100"');
    expect(findMismatchedEnvKeys(envPath, { DATABASE_URL: 'postgresql://a', PORT: '3100' })).toEqual([
      'DATABASE_URL',
    ]);
  });

  it('treats a missing key as mismatched', () => {
    fs.writeFileSync(envPath, 'OTHER="x"');
    expect(findMismatchedEnvKeys(envPath, { DATABASE_URL: 'postgresql://a' })).toEqual(['DATABASE_URL']);
  });
});

describe('generateCronSecret', () => {
  it('returns a 48-character lowercase hex string', () => {
    const secret = generateCronSecret();
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
  });

  it('returns a different value on each call', () => {
    expect(generateCronSecret()).not.toBe(generateCronSecret());
  });
});

describe('hasEmptyCronSecret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-env-cron-test-'));
  const envPath = path.join(dir, '.env');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('returns true when CRON_SECRET is missing entirely', () => {
    fs.writeFileSync(envPath, 'OTHER="x"');
    expect(hasEmptyCronSecret(envPath)).toBe(true);
  });

  it('returns true when CRON_SECRET is present but blank', () => {
    fs.writeFileSync(envPath, 'CRON_SECRET=""');
    expect(hasEmptyCronSecret(envPath)).toBe(true);
  });

  it('returns false when CRON_SECRET holds a value', () => {
    fs.writeFileSync(envPath, 'CRON_SECRET="abc123"');
    expect(hasEmptyCronSecret(envPath)).toBe(false);
  });

  it('returns true when CRON_SECRET is whitespace-only', () => {
    fs.writeFileSync(envPath, 'CRON_SECRET="   "');
    expect(hasEmptyCronSecret(envPath)).toBe(true);
  });
});

describe('findStaleEnvKeys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-env-stale-test-'));
  const envPath = path.join(dir, '.env');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('returns empty array when .env is fully healthy (deterministic keys match, CRON_SECRET populated)', () => {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://a"\nCRON_SECRET="abc123xyz"');
    expect(findStaleEnvKeys(envPath, { DATABASE_URL: 'postgresql://a' })).toEqual([]);
  });

  it('returns only CRON_SECRET when it is blank but deterministic keys match', () => {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://a"\nCRON_SECRET=""');
    expect(findStaleEnvKeys(envPath, { DATABASE_URL: 'postgresql://a' })).toEqual(['CRON_SECRET']);
  });

  it('returns only the mismatched deterministic key when CRON_SECRET is populated', () => {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://stale"\nCRON_SECRET="abc123xyz"');
    expect(findStaleEnvKeys(envPath, { DATABASE_URL: 'postgresql://new' })).toEqual(['DATABASE_URL']);
  });

  it('returns both mismatched deterministic keys and blank CRON_SECRET', () => {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://stale"\nCRON_SECRET=""');
    expect(findStaleEnvKeys(envPath, { DATABASE_URL: 'postgresql://new' })).toEqual([
      'DATABASE_URL',
      'CRON_SECRET',
    ]);
  });
});
