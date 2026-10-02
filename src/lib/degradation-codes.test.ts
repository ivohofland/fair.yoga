import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DEGRADATION_CODES } from './degradation-codes';

const PERSONAL_DATA_KEY = /name|email|phone|address|birth|note|message|text/i;

describe('DEGRADATION_CODES', () => {
  const entries = Object.entries(DEGRADATION_CODES);

  it.each(entries)('%s has a description and a level', (_code, entry) => {
    expect(entry.description.length).toBeGreaterThan(20);
    expect(['warn', 'error']).toContain(entry.level);
  });

  it.each(entries)('%s lists each context key once', (_code, entry) => {
    expect(new Set(entry.contextKeys).size).toBe(entry.contextKeys.length);
  });

  it.each(entries)('%s allowlists no key that could carry personal data', (_code, entry) => {
    for (const key of entry.contextKeys) {
      expect(key, `context key "${key}"`).not.toMatch(PERSONAL_DATA_KEY);
    }
  });
});

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const DEFINITION = path.join(SRC, 'lib', 'degradation.ts');
const files = sourceFiles(SRC).filter((f) => f !== DEFINITION);
const LITERAL_CALL = /logDegraded\(\s*'([A-Z0-9_]+)'/g;
const ANY_CALL = /logDegraded\(/g;

describe('logDegraded call sites', () => {
  const used = new Set<string>();
  let literalCalls = 0;
  let anyCalls = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(LITERAL_CALL)) {
      used.add(m[1]!);
      literalCalls += 1;
    }
    anyCalls += [...text.matchAll(ANY_CALL)].length;
  }

  it('names its code as a literal at every call, never through a variable', () => {
    expect(anyCalls).toBe(literalCalls);
  });

  it.each(Object.keys(DEGRADATION_CODES))('%s has at least one call site', (code) => {
    expect(used.has(code)).toBe(true);
  });

  it('calls only registered codes', () => {
    for (const code of used) expect(Object.keys(DEGRADATION_CODES)).toContain(code);
  });
});

// The digest footer sends the operator to this file for what each code means.
const RUNBOOK = readFileSync(path.resolve(SRC, '..', 'docs', 'degradation-sites.md'), 'utf8');
const RUNBOOK_HEADINGS = new Set(
  RUNBOOK.split('\n').flatMap((line) => {
    const m = /^### `([A-Z0-9_]+)`$/.exec(line);
    return m ? [m[1]!] : [];
  }),
);

describe('docs/degradation-sites.md', () => {
  it.each(Object.keys(DEGRADATION_CODES))('%s has a runbook section in docs/degradation-sites.md', (code) => {
    expect(RUNBOOK_HEADINGS.has(code), `no "### \`${code}\`" heading`).toBe(true);
  });
});
