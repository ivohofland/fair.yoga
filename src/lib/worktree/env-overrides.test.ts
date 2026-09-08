import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildEnvOverrides } from './env-overrides';

describe('buildEnvOverrides', () => {
  it('rewrites both DATABASE_URL variants, INTEGRATION_BASE_URL, and NEXT_PUBLIC_APP_URL', () => {
    const result = buildEnvOverrides('postgresql://yoga:pw@localhost:5432', 'ethical_yoga_dev_x', 'ethical_yoga_test_x', 3100);
    expect(result).toEqual({
      DATABASE_URL: 'postgresql://yoga:pw@localhost:5432/ethical_yoga_dev_x',
      DATABASE_URL_TEST: 'postgresql://yoga:pw@localhost:5432/ethical_yoga_test_x',
      INTEGRATION_BASE_URL: 'http://localhost:3100',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3100',
    });
  });

  it('re-points every .env.example value that names localhost:3000 or the shared dev database', () => {
    const examplePath = path.resolve(__dirname, '../../../.env.example');
    const template = fs.readFileSync(examplePath, 'utf8');
    const overrides = buildEnvOverrides('postgresql://yoga:pw@localhost:5432', 'dev_x', 'test_x', 3100);

    const staleKeys = template
      .split('\n')
      .map((line) => line.match(/^([A-Z_][A-Z0-9_]*)="[^"]*(localhost:3000|localhost:5432\/ethical_yoga)[^"]*"/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => match[1]);

    for (const key of staleKeys) {
      expect(Object.keys(overrides)).toContain(key);
    }
  });
});
