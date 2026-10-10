import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `docker-compose.prod.yml` as Docker Compose itself resolves it, so the test
 * reads the same values a deploy uses. Skipped where no docker CLI exists
 * (CI's runners have one).
 */
const COMPOSE_FILE = path.resolve(__dirname, '..', 'docker-compose.prod.yml');
const HAS_COMPOSE = spawnSync('docker', ['compose', 'version']).status === 0;

/** Compose's resolved durations are nanoseconds in the JSON output. */
const NS_PER_SECOND = 1_000_000_000;

describe.skipIf(!HAS_COMPOSE)('docker-compose.prod.yml', () => {
  it('stops the app within a few seconds instead of Docker\'s ten', () => {
    // The app service names `env_file: .env`, which config insists exists; a
    // copy beside an empty one resolves without touching a real .env.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-compose-'));
    fs.copyFileSync(COMPOSE_FILE, path.join(dir, 'docker-compose.prod.yml'));
    fs.writeFileSync(path.join(dir, '.env'), '');
    const result = spawnSync('docker', ['compose', '-f', 'docker-compose.prod.yml', 'config', '--format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, POSTGRES_PASSWORD: 'compose-config-test' },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);

    const config = JSON.parse(result.stdout) as {
      services: Record<string, { stop_grace_period?: number | string }>;
    };
    const grace = config.services.app?.stop_grace_period;
    expect(grace, 'app.stop_grace_period is not set').toBeDefined();

    const seconds = typeof grace === 'number' ? grace / NS_PER_SECOND : Number.parseFloat(String(grace));
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(5);
  });
});
