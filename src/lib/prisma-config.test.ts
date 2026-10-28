import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Importing the config would otherwise load the checkout's `.env` into this
// worker's environment.
vi.mock('dotenv/config', () => ({}));

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PRISMA_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'prisma');
const CLI_TIMEOUT_MS = 90_000;
/** The CLI's refusal when a command needs a URL and the config holds none. */
const NO_URL = 'The datasource.url property is required in your Prisma config file';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A directory shaped like a fresh clone: the config, the schema and the repo's
 * `node_modules`, and no `.env` unless the test writes one. The schema's
 * generator writes into the directory, so `generate` cannot replace the repo's
 * generated client.
 */
function freshClone(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-prisma-config-'));
  tempDirs.push(dir);
  fs.copyFileSync(path.join(REPO_ROOT, 'prisma.config.ts'), path.join(dir, 'prisma.config.ts'));
  fs.mkdirSync(path.join(dir, 'prisma'));
  const schema = fs.readFileSync(path.join(REPO_ROOT, 'prisma', 'schema.prisma'), 'utf8');
  expect(schema.match(/output\s*=\s*"[^"]*"/g)).toHaveLength(1);
  const redirected = schema.replace(
    /output\s*=\s*"[^"]*"/,
    `output       = "${path.join(dir, 'generated-client')}"`,
  );
  expect(redirected).not.toBe(schema);
  fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), redirected);
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

/**
 * The Prisma CLI in `cwd`, with no database URL inherited from the worker
 * unless `extraEnv` sets one. It must report loading the config file: without
 * it the CLI has no datasource URL and loads no `.env`, so the `.env` case
 * fails with `NO_URL` while the `generate` case would still pass.
 */
function runPrisma(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; output: string } {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.DATABASE_URL_TEST;
  Object.assign(env, extraEnv);
  const result = spawnSync(PRISMA_BIN, args, { cwd, env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
  expect(result.error).toBeUndefined();
  const output = `${result.stdout}${result.stderr}`;
  expect(output).toContain('Loaded Prisma config from prisma.config.ts');
  return { status: result.status, output };
}

describe('prisma.config.ts', () => {
  it('takes the database URL from .env alone', () => {
    const dir = freshClone();
    fs.writeFileSync(
      path.join(dir, '.env'),
      'DATABASE_URL="postgresql://u:p@203.0.113.1:5432/none?connect_timeout=3"\n',
    );
    const { status, output } = runPrisma(dir, ['migrate', 'status']);
    expect(status).not.toBe(0);
    expect(output).toContain('P1001');
    expect(output).toContain('203.0.113.1');
    expect(output).not.toContain(NO_URL);
  }, CLI_TIMEOUT_MS);

  it('prefers an explicit DATABASE_URL over .env', () => {
    const dir = freshClone();
    fs.writeFileSync(
      path.join(dir, '.env'),
      'DATABASE_URL="postgresql://u:p@203.0.113.1:5432/none?connect_timeout=3"\n',
    );
    const { status, output } = runPrisma(dir, ['migrate', 'status'], {
      DATABASE_URL: 'postgresql://u:p@203.0.113.2:5432/none?connect_timeout=3',
    });
    expect(status).not.toBe(0);
    expect(output).toContain('P1001');
    expect(output).toContain('203.0.113.2');
    expect(output).not.toContain('203.0.113.1');
  }, CLI_TIMEOUT_MS);

  it('fails loudly naming datasource.url when a command needs a URL and none is set', () => {
    const dir = freshClone();
    const { status, output } = runPrisma(dir, ['migrate', 'status']);
    expect(status).not.toBe(0);
    expect(output).toContain(NO_URL);
  }, CLI_TIMEOUT_MS);

  it('lets generate run with no .env and no DATABASE_URL', () => {
    const dir = freshClone();
    const { status, output } = runPrisma(dir, ['generate']);
    expect(output).not.toContain('PrismaConfigEnvError');
    expect(status).toBe(0);
  }, CLI_TIMEOUT_MS);

  it('names the schema and the seed command, and package.json carries no prisma key', async () => {
    const { default: config } = await import('../../prisma.config');
    expect(config.schema).toBe('prisma/schema.prisma');
    expect(config.migrations?.seed).toBe('pnpm exec tsx prisma/seed.ts');
    const pkg: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg).not.toHaveProperty('prisma');
  });
});
