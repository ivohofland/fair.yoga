import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * `deploy/backup.sh` against stub `docker` and `age` binaries on PATH: the
 * stubs stand in for `pg_dump` inside the db container and for the real
 * encryption, so these tests pin the script's own plumbing — what it refuses,
 * what it leaves on disk, and what it rotates.
 */
const SCRIPT = path.resolve(__dirname, 'backup.sh');
const DUMP = 'CREATE TABLE "Teacher" ();\n';

let root: string;
let backupDir: string;
let binDir: string;
let recipients: string;

function writeStub(name: string, body: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function run(env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      COMPOSE_FILE: path.join(root, 'compose.yml'),
      BACKUP_DIR: backupDir,
      AGE_RECIPIENTS_FILE: recipients,
      ...env,
    },
  });
}

function backups(): string[] {
  return fs.readdirSync(backupDir).sort();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-backup-'));
  backupDir = path.join(root, 'backups');
  binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  recipients = path.join(root, 'recipients.txt');
  fs.writeFileSync(recipients, 'age1examplerecipient\n');
  // `docker compose -f … exec -T db sh -c 'pg_dump …'` prints the dump, or
  // fails like a stopped container when FAKE_DOCKER_FAIL is set.
  writeStub('docker', `[ -n "\${FAKE_DOCKER_FAIL:-}" ] && { echo "service db is not running" >&2; exit 1; }\nprintf '%s' '${DUMP}'`);
  // `age -R <file>`: records its arguments and marks its output, so a test can
  // tell an encrypted file from a plaintext one without real keys.
  writeStub('age', `printf '%s\\n' "$@" > "${root}/age-args"\nprintf 'AGE-ENCRYPTED\\n'\ncat`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('deploy/backup.sh', () => {
  it('writes one encrypted dump, readable by its owner only, and nothing in plaintext', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);

    const files = backups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^fairyoga-\d{8}-\d{6}\.sql\.gz\.age$/);

    const file = path.join(backupDir, files[0]!);
    const body = fs.readFileSync(file);
    const marker = Buffer.from('AGE-ENCRYPTED\n');
    expect(body.subarray(0, marker.length).equals(marker)).toBe(true);
    expect(gunzipSync(body.subarray(marker.length)).toString()).toBe(DUMP);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    expect(fs.readFileSync(path.join(root, 'age-args'), 'utf8').split('\n')).toEqual(
      expect.arrayContaining(['-R', recipients]),
    );
  });

  it('refuses without a recipients file, rather than write a plaintext dump', () => {
    fs.rmSync(recipients);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(recipients);
    expect(fs.existsSync(backupDir) ? backups() : []).toEqual([]);
  });

  // A PATH holding only the stub directory and the shell's own tools, so a
  // real `age` elsewhere on the machine running the test cannot be found; a
  // machine with `age` in one of those two directories cannot run this case.
  const ageInSystemDirs = fs.existsSync('/usr/bin/age') || fs.existsSync('/bin/age');
  it.skipIf(ageInSystemDirs)('refuses when age is not installed', () => {
    fs.rmSync(path.join(binDir, 'age'));
    const result = run({ PATH: `${binDir}:/usr/bin:/bin` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('age');
    expect(fs.existsSync(backupDir) ? backups() : []).toEqual([]);
  });

  it('leaves no file behind when the dump fails', () => {
    const result = run({ FAKE_DOCKER_FAIL: '1' });
    expect(result.status).not.toBe(0);
    expect(backups()).toEqual([]);
  });

  it('rotates encrypted and older plaintext dumps past KEEP_DAYS and keeps the rest', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const old = (Date.now() - 20 * 86_400_000) / 1000;
    for (const name of ['fairyoga-20200101-031700.sql.gz.age', 'fairyoga-20200101-031700.sql.gz']) {
      fs.writeFileSync(path.join(backupDir, name), 'x');
      fs.utimesSync(path.join(backupDir, name), old, old);
    }
    fs.writeFileSync(path.join(backupDir, 'unrelated.txt'), 'x');
    fs.utimesSync(path.join(backupDir, 'unrelated.txt'), old, old);

    const result = run({ KEEP_DAYS: '14' });
    expect(result.status, result.stderr).toBe(0);

    const files = backups();
    expect(files).toContain('unrelated.txt');
    expect(files.filter((f) => f.startsWith('fairyoga-'))).toHaveLength(1);
    expect(files.find((f) => f.startsWith('fairyoga-'))).toMatch(/\.sql\.gz\.age$/);
  });
});
