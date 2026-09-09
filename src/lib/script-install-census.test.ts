/**
 * Every committed script installs from the lockfile.
 *
 * `npm ci` installs `package-lock.json` exactly and fails when `package.json`
 * disagrees with it. `npm install` reconciles instead: it may resolve a range
 * afresh against the registry, and it may rewrite the lockfile. A script that
 * bootstraps a checkout wants the first behaviour — the versions someone
 * committed, or a loud failure — and this file is what makes that a failing
 * build rather than a review note.
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT. It reads the literal in the
 * first argument position of a `child_process` exec-family call under
 * `scripts/`: where that literal is an npm install-family command, it must be
 * `npm ci`. So it sees `execSync('npm install')`, and it does not see a
 * command assembled from variables, one reached through a shell script, or an
 * install a dependency performs on its own.
 *
 * IT READS THE CALL, NOT THE FILE, and that distinction is load-bearing. An
 * earlier draft matched any quoted literal, which made a comment *about*
 * `npm install` — including the one in `scripts/worktree-setup.ts` explaining
 * why it does not use it — indistinguishable from an invocation of it. Prose
 * discussing a command is not a use of it, and a guard that cannot tell them
 * apart taxes the very comment that explains the rule.
 *
 * IT WATCHES `scripts/` AND NOTHING ELSE, deliberately. The other install
 * paths here are declarative and read on every change (`Dockerfile`,
 * `.github/workflows/`); the one that slipped was imperative code, which is
 * where a rule goes unnoticed. Widening means a second matcher over YAML and
 * Dockerfile text, with its own false positives, for paths already correct.
 *
 * THE DISCOVERY IS ASSERTED, NOT ASSUMED. A guard that finds no commands
 * reports no violations, which reads exactly like a healthy repository. The
 * first test below fails when the search stops finding scripts, or stops
 * finding an install among them, so relocating the install cannot quietly
 * retire the rule.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const SCRIPTS_DIR = 'scripts';

/**
 * npm's install family: the subcommands that populate `node_modules`. Only
 * `ci` installs the committed tree — every other member resolves, which is
 * the behaviour this rule exists to keep out of a bootstrap script.
 */
const INSTALL_FAMILY = ['ci', 'install', 'add', 'update', 'i', 'up'] as const;

const INSTALL_COMMAND = new RegExp(`^npm\\s+(?:${INSTALL_FAMILY.join('|')})\\b`);

/**
 * A quoted literal in the first argument position of a `child_process`
 * exec-family call — the shape of a command this repo actually runs. Backtick
 * literals are matched only without substitution, since a command built by
 * interpolation is not one this file can read.
 */
const EXEC_CALL =
  /\b(?:execSync|execFileSync|exec|spawnSync|spawn)\s*\(\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\\n$]*)`)/g;

interface Invocation {
  file: string;
  command: string;
}

function scriptFiles(): string[] {
  return readdirSync(path.join(root, SCRIPTS_DIR), { encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `${SCRIPTS_DIR}/${name}`);
}

function installInvocations(): Invocation[] {
  const found: Invocation[] = [];
  for (const file of scriptFiles()) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(EXEC_CALL)) {
      const command = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (INSTALL_COMMAND.test(command)) found.push({ file, command });
    }
  }
  return found;
}

describe('every committed script installs from the lockfile', () => {
  it('finds the scripts, and finds an install among them', () => {
    // First, because the assertion after it passes vacuously on an empty set:
    // a search that finds no install reports no violation, and that is
    // indistinguishable from a repository where every install is correct.
    // Booleans rather than counts, so a failure says which half broke.
    expect({
      scriptsFound: scriptFiles().length > 0,
      installsFound: installInvocations().length > 0,
    }).toEqual({ scriptsFound: true, installsFound: true });
  });

  it('runs npm ci, never a command that resolves', () => {
    // Reports the offending invocations rather than a count, so a failure
    // names the file and the command it found.
    expect(installInvocations().filter(({ command }) => command !== 'npm ci')).toEqual([]);
  });
});
