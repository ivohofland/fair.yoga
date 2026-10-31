import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
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
/** Not the script's default, so a call that drops `-f "$COMPOSE_FILE"` or hardcodes the name shows. */
const COMPOSE_FILE = 'compose.under-test.yml';

let root: string;
let origin: string;
let app: string;
let binDir: string;
let callLog: string;
let deployedFile: string;

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

/** Commits a compose file whose `db` service runs `image` to origin's main and returns the new SHA. */
function commitComposeToOrigin(image: string): string {
  const work = path.join(root, 'work');
  fs.writeFileSync(path.join(work, COMPOSE_FILE), `services:\n  db:\n    image: ${image}\n`);
  git(work, 'add', COMPOSE_FILE);
  git(work, 'commit', '-q', '-m', image);
  git(work, 'push', '-q', 'origin', 'main');
  return git(work, 'rev-parse', 'HEAD');
}

function scriptEnv(input: { sshCommand?: string; env?: Record<string, string> }): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: root,
    APP_DIR: app,
    COMPOSE_FILE,
    HEALTH_URL: 'http://127.0.0.1:3000/api/health',
    HEALTH_TIMEOUT: '2',
    LOCK_FILE: path.join(root, 'deploy.lock'),
    DEPLOYED_FILE: deployedFile,
    ...(input.sshCommand === undefined ? {} : { SSH_ORIGINAL_COMMAND: input.sshCommand }),
    ...input.env,
  };
}

function run(input: { sshCommand?: string; arg?: string; env?: Record<string, string> } = {}) {
  return spawnSync('bash', input.arg === undefined ? [SCRIPT] : [SCRIPT, input.arg], { encoding: 'utf8', env: scriptEnv(input) });
}

/** The recorded deployed commit, or null when the script has not written one. */
function recorded(): string | null {
  return fs.existsSync(deployedFile) ? fs.readFileSync(deployedFile, 'utf8').trim() : null;
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
  deployedFile = path.join(root, 'deployed');
  fs.mkdirSync(binDir);

  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, path.join(root, 'work'));
  git(path.join(root, 'work'), 'checkout', '-q', '-b', 'main');
  commitToOrigin('v1');
  git(root, 'clone', '-q', origin, app);

  // `docker compose … build|run|up …`: logged; each fails when FAKE_BUILD_FAIL /
  // FAKE_MIGRATE_FAIL / FAKE_UP_FAIL is set, and a build first sleeps FAKE_BUILD_SLEEP seconds.
  writeStub(
    'docker',
    [
      `echo "docker $*" >> "${callLog}"`,
      'case " $* " in',
      '  *" build "*) [ -n "${FAKE_BUILD_SLEEP:-}" ] && sleep "$FAKE_BUILD_SLEEP"; [ -n "${FAKE_BUILD_FAIL:-}" ] && exit 1;;',
      '  *" run "*) [ -n "${FAKE_MIGRATE_FAIL:-}" ] && exit 1;;',
      '  *" up "*) [ -n "${FAKE_UP_FAIL:-}" ] && exit 1;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  if (!HAS_FLOCK) writeStub('flock', 'exit 0');
  // The health probe answers ok unless FAKE_HEALTH is set to something else.
  writeStub('curl', `echo "curl" >> "${callLog}"\nprintf '%s' "\${FAKE_HEALTH:-{\\"status\\":\\"ok\\",\\"db\\":\\"up\\"}}"`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('deploy/deploy.sh', () => {
  it('deploys a newer main commit: checks it out, builds, migrates, then starts, and passes the health check', () => {
    const v2 = commitToOrigin('v2');
    const result = run({ sshCommand: v2 });

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(head()).toBe(v2);
    const docker = calls().filter((c) => c.startsWith('docker'));
    const buildAt = docker.findIndex((c) => / build( |$)/.test(c));
    const migrateAt = docker.findIndex((c) => / run --rm migrate( |$)/.test(c));
    const upAt = docker.findIndex((c) => / up -d/.test(c));
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(migrateAt).toBeGreaterThan(buildAt);
    expect(upAt).toBeGreaterThan(migrateAt);
    for (const call of docker.filter((c) => c.startsWith('docker compose'))) expect(call).toMatch(new RegExp(`^docker compose -f ${COMPOSE_FILE} `));
    expect(calls()).toContain('curl');
    expect(recorded()).toBe(v2);
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
    expect(calls().some((c) => / run /.test(c))).toBe(false);
    expect(calls().some((c) => / up -d/.test(c))).toBe(false);
    expect(recorded()).toBe(before);
  });

  it('puts the checkout back and replaces no container when the migration fails', () => {
    const before = head();
    const v2 = commitToOrigin('v2');
    const result = run({ sshCommand: v2, env: { FAKE_MIGRATE_FAIL: '1' } });

    expect(result.status).not.toBe(0);
    expect(head()).toBe(before);
    expect(calls().some((c) => / up( |$)/.test(c))).toBe(false);
    expect(result.stderr).toContain('migrate');
    expect(result.stderr).toContain('no container was replaced');
    expect(recorded()).toBe(before);
  });

  it('refuses a commit that changes the postgres major, before any docker call, putting the checkout back', () => {
    const v16 = commitComposeToOrigin(`postgres:16-alpine@sha256:${'a'.repeat(64)}`);
    expect(run({ sshCommand: v16 }).status).toBe(0);
    fs.rmSync(callLog);
    const v18 = commitComposeToOrigin(`postgres:18-alpine@sha256:${'b'.repeat(64)}`);

    const result = run({ sshCommand: v18 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('postgres 16 -> 18');
    expect(result.stderr).toContain('#949');
    expect(head()).toBe(v16);
    expect(recorded()).toBe(v16);
    expect(calls().filter((c) => c.startsWith('docker'))).toEqual([]);
  });

  it('deploys a postgres digest change within the same major', () => {
    const before = commitComposeToOrigin(`postgres:16-alpine@sha256:${'a'.repeat(64)}`);
    expect(run({ sshCommand: before }).status).toBe(0);
    const after = commitComposeToOrigin(`postgres:16-alpine@sha256:${'c'.repeat(64)}`);

    const result = run({ sshCommand: after });
    expect(result.status, result.stderr).toBe(0);
    expect(recorded()).toBe(after);
  });

  it('names both commits and the rollback when replacing the containers fails', () => {
    const before = head();
    const v2 = commitToOrigin('v2');
    const result = run({ sshCommand: v2, env: { FAKE_UP_FAIL: '1' } });

    expect(result.status).not.toBe(0);
    expect(calls()).not.toContain('curl');
    expect(head()).toBe(v2);
    expect(result.stderr).toContain(before);
    expect(result.stderr).toContain(v2);
    expect(result.stderr).toContain('rolling back');
  });

  it('fails when the app does not report ok within the health timeout', () => {
    const before = head();
    const v2 = commitToOrigin('v2');
    const result = run({ sshCommand: v2, env: { FAKE_HEALTH: '{"status":"degraded","db":"down"}' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/health/i);
    expect(head()).toBe(v2);
    expect(result.stderr).toContain(before);
    expect(result.stderr).toContain(v2);
    expect(result.stderr).toContain('rolling back');
  }, 20_000);

  it('seeds the record from HEAD before a first deploy that fails at the swap, and runs the whole deploy again on a retry', () => {
    const before = head();
    const v2 = commitToOrigin('v2');
    expect(run({ sshCommand: v2, env: { FAKE_UP_FAIL: '1' } }).status).not.toBe(0);
    expect(recorded()).toBe(before);
    expect(head()).toBe(v2);
    fs.rmSync(callLog);

    const retry = run({ sshCommand: v2 });
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).not.toMatch(/already/i);
    const docker = calls().filter((c) => c.startsWith('docker'));
    expect(docker.some((c) => / build( |$)/.test(c))).toBe(true);
    expect(docker.some((c) => / run --rm migrate( |$)/.test(c))).toBe(true);
    expect(docker.some((c) => / up -d/.test(c))).toBe(true);
    expect(recorded()).toBe(v2);
  });

  it('leaves the record alone when the health check fails, and runs the whole deploy again on a retry', () => {
    const before = head();
    const v2 = commitToOrigin('v2');
    fs.writeFileSync(deployedFile, `${before}\n`);
    expect(run({ sshCommand: v2, env: { FAKE_HEALTH: '{"status":"degraded","db":"down"}' } }).status).not.toBe(0);
    expect(recorded()).toBe(before);
    expect(head()).toBe(v2);
    fs.rmSync(callLog);

    const retry = run({ sshCommand: v2 });
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).not.toMatch(/already/i);
    const docker = calls().filter((c) => c.startsWith('docker'));
    expect(docker.some((c) => / build( |$)/.test(c))).toBe(true);
    expect(docker.some((c) => / run --rm migrate( |$)/.test(c))).toBe(true);
    expect(docker.some((c) => / up -d/.test(c))).toBe(true);
    expect(recorded()).toBe(v2);
  }, 20_000);

  it('refuses, naming both commits, to answer "already there" for the recorded commit while the checkout sits on a commit that failed its health check', () => {
    const v1 = head();
    const v2 = commitToOrigin('v2');
    fs.writeFileSync(deployedFile, `${v1}\n`);
    expect(run({ sshCommand: v2, env: { FAKE_HEALTH: '{"status":"degraded","db":"down"}' } }).status).not.toBe(0);
    expect(head()).toBe(v2);
    fs.rmSync(callLog);

    const result = run({ sshCommand: v1 });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toMatch(/already/i);
    expect(result.stderr).toContain(v1);
    expect(result.stderr).toContain(v2);
    expect(head()).toBe(v2);
    expect(recorded()).toBe(v1);
    expect(calls().filter((c) => c.startsWith('docker'))).toEqual([]);
  }, 20_000);

  it('puts the checkout back where it found it, not on the record, when a later deploy fails before the swap, so the recorded commit still refuses', () => {
    const v1 = head();
    const v2 = commitToOrigin('v2');
    const v3 = commitToOrigin('v3');
    fs.writeFileSync(deployedFile, `${v1}\n`);
    expect(run({ sshCommand: v2, env: { FAKE_HEALTH: '{"status":"degraded","db":"down"}' } }).status).not.toBe(0);
    expect(head()).toBe(v2);
    expect(recorded()).toBe(v1);

    const failedBuild = run({ sshCommand: v3, env: { FAKE_BUILD_FAIL: '1' } });
    expect(failedBuild.status).not.toBe(0);
    expect(head()).toBe(v2);
    expect(recorded()).toBe(v1);
    fs.rmSync(callLog);

    const result = run({ sshCommand: v1 });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toMatch(/already/i);
    expect(result.stderr).toContain(v1);
    expect(result.stderr).toContain(v2);
    expect(calls().filter((c) => c.startsWith('docker'))).toEqual([]);
  }, 20_000);

  it('refuses an empty record, moving nothing', () => {
    const v2 = commitToOrigin('v2');
    const before = head();
    fs.writeFileSync(deployedFile, '');
    const result = run({ sshCommand: v2 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(deployedFile);
    expect(head()).toBe(before);
    expect(recorded()).toBe('');
    expect(calls().filter((c) => c.startsWith('docker'))).toEqual([]);
  });

  it('refuses a record that does not hold a full commit hash, moving nothing', () => {
    const v2 = commitToOrigin('v2');
    const before = head();
    fs.writeFileSync(deployedFile, 'main\n');
    const result = run({ sshCommand: v2 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(deployedFile);
    expect(head()).toBe(before);
    expect(recorded()).toBe('main');
    expect(calls().filter((c) => c.startsWith('docker'))).toEqual([]);
  });

  it('creates the record from HEAD when there is none, and compares against the record when there is one', () => {
    const v1 = head();
    const v2 = commitToOrigin('v2');
    const v3 = commitToOrigin('v3');
    expect(recorded()).toBeNull();
    const first = run({ sshCommand: v2 });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`deploying ${v1} -> ${v2}`);
    expect(recorded()).toBe(v2);

    const second = run({ sshCommand: v3 });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(`deploying ${v2} -> ${v3}`);
    expect(recorded()).toBe(v3);
  });

  it('puts the checkout back and starts nothing when it is terminated during the build', async () => {
    const before = head();
    const v2 = commitToOrigin('v2');
    const child: ChildProcess = spawn('bash', [SCRIPT], { env: scriptEnv({ sshCommand: v2, env: { FAKE_BUILD_SLEEP: '5' } }), stdio: ['ignore', 'ignore', 'ignore'] });
    const closed = new Promise<number | null>((resolve) => child.on('close', (code: number | null) => resolve(code)));

    try {
      const deadline = Date.now() + 10_000;
      while (!calls().some((c) => / build( |$)/.test(c)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(calls().some((c) => / build( |$)/.test(c))).toBe(true);
      expect(head()).toBe(v2);
      child.kill('SIGTERM');

      const code = await closed;
      expect(code).toBe(143);
      expect(head()).toBe(before);
      expect(recorded()).toBe(before);
      expect(calls().some((c) => / up( |$)/.test(c))).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);

  it('puts the checkout back and starts nothing when the output is closed mid-deploy', async () => {
    const before = head();
    const v2 = commitToOrigin('v2');
    const child = spawn('bash', [SCRIPT], { env: scriptEnv({ sshCommand: v2, env: { FAKE_BUILD_SLEEP: '5', FAKE_BUILD_FAIL: '1' } }), stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));

    try {
      const deadline = Date.now() + 10_000;
      while (!calls().some((c) => / build( |$)/.test(c)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(calls().some((c) => / build( |$)/.test(c))).toBe(true);
      expect(head()).toBe(v2);
      // Nothing reads the pipes any more, simulating a dropped SSH connection; the failed build's message is then written to a closed pipe.
      child.stdout.destroy();
      child.stderr.destroy();

      await closed;
      expect(head()).toBe(before);
      expect(recorded()).toBe(before);
      expect(calls().some((c) => / up( |$)/.test(c))).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);

  it.skipIf(!HAS_FLOCK)('refuses to run while another deploy holds the lock', () => {
    const v2 = commitToOrigin('v2');
    const lock = path.join(root, 'deploy.lock');
    // A separate process holds the lock, as a concurrent deploy's would. Not
    // `exec 9>…; flock 9; bash script` with the script last: bash execs a `-c`
    // string's last command, leaving the script as the lock's only holder.
    // The holder gets no stdio: spawnSync waits for every process holding its
    // pipes, and the holder's `sleep` outlives a `kill` of `flock`.
    const holder = spawnSync('bash', ['-c', `flock "${lock}" sleep 3 </dev/null >/dev/null 2>&1 & sleep 0.5; bash "${SCRIPT}"; rc=$?; kill %1 2>/dev/null; exit $rc`], {
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
