import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `deploy/deploy.sh` against a real git origin and checkout in a temp
 * directory, with `docker` and `curl` stubbed on PATH. The stubs log every
 * call to one file, so a test can tell what the script built and started, and
 * in which order.
 */
const SCRIPT = path.resolve(__dirname, 'deploy.sh');
/** The server and CI have util-linux `flock`; macOS does not, so there it is stubbed and the lock case skipped. */
const HAS_FLOCK = spawnSync('sh', ['-c', 'command -v flock']).status === 0;

let root: string;
let origin: string;
let app: string;
let binDir: string;
let callLog: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();
}

function writeStub(name: string, body: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/** Commits one file change to origin's main and returns the new SHA. */
function commitToOrigin(label: string): string {
  const work = path.join(root, 'work');
  fs.writeFileSync(path.join(work, 'version.txt'), `${label}\n`);
  git(work, 'add', 'version.txt');
  git(work, 'commit', '-q', '-m', label);
  git(work, 'push', '-q', 'origin', 'main');
  return git(work, 'rev-parse', 'HEAD');
}

function run(input: { sshCommand?: string; arg?: string; env?: Record<string, string> } = {}) {
  return spawnSync('bash', input.arg === undefined ? [SCRIPT] : [SCRIPT, input.arg], {
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: root,
      APP_DIR: app,
      COMPOSE_FILE: 'docker-compose.prod.yml',
      HEALTH_URL: 'http://127.0.0.1:3000/api/health',
      HEALTH_TIMEOUT: '2',
      LOCK_FILE: path.join(root, 'deploy.lock'),
      ...(input.sshCommand === undefined ? {} : { SSH_ORIGINAL_COMMAND: input.sshCommand }),
      ...input.env,
    },
  });
}

function calls(): string[] {
  return fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function head(): string {
  return git(app, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-deploy-'));
  origin = path.join(root, 'origin.git');
  app = path.join(root, 'app');
  binDir = path.join(root, 'bin');
  callLog = path.join(root, 'calls');
  fs.mkdirSync(binDir);

  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, path.join(root, 'work'));
  git(path.join(root, 'work'), 'checkout', '-q', '-b', 'main');
  commitToOrigin('v1');
  git(root, 'clone', '-q', origin, app);

  // `docker compose … build|up …`: logged; `build` fails when FAKE_BUILD_FAIL is set.
  writeStub(
    'docker',
    `echo "docker $*" >> "${callLog}"\ncase " $* " in *" build "*) [ -n "\${FAKE_BUILD_FAIL:-}" ] && exit 1;; esac\nexit 0`,
  );
  if (!HAS_FLOCK) writeStub('flock', 'exit 0');
  // The health probe answers ok unless FAKE_HEALTH is set to something else.
  writeStub('curl', `echo "curl" >> "${callLog}"\nprintf '%s' "\${FAKE_HEALTH:-{\\"status\\":\\"ok\\",\\"db\\":\\"up\\"}}"`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('deploy/deploy.sh', () => {
  it('deploys a newer main commit: checks it out, builds, then starts, and passes the health check', () => {
    const v2 = commitToOrigin('v2');
    const result = run({ sshCommand: v2 });

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(head()).toBe(v2);
    const docker = calls().filter((c) => c.startsWith('docker'));
    const buildAt = docker.findIndex((c) => / build( |$)/.test(c));
    const upAt = docker.findIndex((c) => / up -d/.test(c));
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(upAt).toBeGreaterThan(buildAt);
    expect(calls()).toContain('curl');
  });

  it('takes the commit as an argument when run by hand', () => {
    const v2 = commitToOrigin('v2');
    const result = run({ arg: v2 });
    expect(result.status, result.stderr).toBe(0);
    expect(head()).toBe(v2);
  });

  it.each([
    ['empty', ''],
    ['short', 'abc123'],
    ['uppercase', 'A'.repeat(40)],
    ['with a second word', `${'a'.repeat(40)} ; rm -rf /`],
    ['a branch name', 'main'],
  ])('refuses a request that is not one full commit hash (%s), touching nothing', (_label, request) => {
    const before = head();
    const result = run({ sshCommand: request });
    expect(result.status).not.toBe(0);
    expect(head()).toBe(before);
    expect(calls()).toEqual([]);
  });

  it('refuses a commit that is not on origin/main', () => {
    const work = path.join(root, 'work');
    git(work, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(work, 'side.txt'), 'x');
    git(work, 'add', 'side.txt');
    git(work, 'commit', '-q', '-m', 'side');
    git(work, 'push', '-q', 'origin', 'side');
    const side = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', 'main');

    const before = head();
    const result = run({ sshCommand: side });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('origin/main');
    expect(head()).toBe(before);
    expect(calls().filter((c) => c.startsWith('docker'))).toEqual([]);
  });

  it('answers success and does nothing for the commit already deployed or an older one', () => {
    const v1 = head();
    const v2 = commitToOrigin('v2');
    expect(run({ sshCommand: v2 }).status).toBe(0);
    fs.rmSync(callLog);

    for (const sha of [v2, v1]) {
      const result = run({ sshCommand: sha });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/already/i);
      expect(head()).toBe(v2);
    }
    expect(calls().filter((c) => c.startsWith('docker'))).toEqual([]);
  });

  it('puts the checkout back and starts nothing when the build fails', () => {
    const before = head();
    const v2 = commitToOrigin('v2');
    const result = run({ sshCommand: v2, env: { FAKE_BUILD_FAIL: '1' } });

    expect(result.status).not.toBe(0);
    expect(head()).toBe(before);
    expect(calls().some((c) => / up -d/.test(c))).toBe(false);
  });

  it('fails when the app does not report ok within the health timeout', () => {
    const v2 = commitToOrigin('v2');
    const result = run({ sshCommand: v2, env: { FAKE_HEALTH: '{"status":"degraded","db":"down"}' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/health/i);
  });

  it.skipIf(!HAS_FLOCK)('refuses to run while another deploy holds the lock', () => {
    const v2 = commitToOrigin('v2');
    const lock = path.join(root, 'deploy.lock');
    const holder = spawnSync('bash', ['-c', `exec 9>"${lock}"; flock 9; bash "${SCRIPT}"`], {
      encoding: 'utf8',
      env: {
        NODE_ENV: 'test',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        APP_DIR: app,
        LOCK_FILE: lock,
        SSH_ORIGINAL_COMMAND: v2,
      },
    });
    expect(holder.status).not.toBe(0);
    expect(holder.stderr).toMatch(/another deploy/i);
    expect(calls().filter((c) => c.startsWith('docker'))).toEqual([]);
  });
});
