import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateEnvContent, writeEnvIfMissing } from './env-file';

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
