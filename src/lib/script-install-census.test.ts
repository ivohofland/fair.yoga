/**
 * Every install this repo's own code runs installs from the lockfile.
 *
 * `npm ci` installs `package-lock.json` exactly and fails when `package.json`
 * disagrees with it. `npm install` reconciles instead: it may resolve a range
 * afresh against the registry, and it may rewrite the lockfile. Code that
 * bootstraps a checkout wants the first behaviour — the versions someone
 * committed, or a loud failure — and this file is what makes that a failing
 * build rather than a review note.
 *
 * WHAT IT READS. Call expressions under `scripts/` and `src/lib/`, parsed with
 * `ts.createSourceFile` as the sibling censuses do. A call counts when its
 * callee NAME is one of `EXEC_CALLEES`; the command is then rebuilt from the
 * first string argument plus, where the second argument is an array of string
 * literals, its elements. That second half matters: `spawnSync`, `spawn`,
 * `execFile` and `execFileSync` take the program and its arguments separately,
 * so `spawnSync('npm', ['install'])` — the shape `worktree/dev-server.ts`
 * already uses for `npx` — carries its subcommand outside the first argument.
 * Reading only the first would watch four functions that could never match.
 *
 * WHAT IT CANNOT SEE, measured rather than assumed:
 *   - a renamed or injected callee (`import { execSync as run }`, or an
 *     `execFn` parameter) — matching is by name, and nothing resolves the
 *     binding back to `child_process`, so a same-named helper counts too;
 *   - a command assembled by interpolation or held in a variable;
 *   - a command behind a prefix (`cd x && npm install`), because the pattern
 *     is anchored;
 *   - anything in a shell script, and any install a dependency performs itself.
 *
 * WHY THESE TWO DIRECTORIES. Imperative bootstrap code lives in both:
 * `scripts/` runs the install, and `src/lib/` runs neighbouring commands
 * (`db-provision.ts` shells out to Prisma). Watching only `scripts/` would
 * also mean that extracting the install into `src/lib/worktree/` — the shape
 * every other side effect in that subsystem already has — silently left the
 * guard behind. The declarative install paths are not read here; they and the
 * human-facing ones are inventoried in `docs/supply-chain.md`, with the
 * command that re-derives the list.
 *
 * TEST FILES ARE EXCLUDED, because a fixture asserting what the guard catches
 * has to contain the very shapes it catches — the cases at the bottom of this
 * file would otherwise fail it.
 *
 * WHY THIS FILE LIVES IN `src/lib/`. `vitest.config.ts`'s `unit` project
 * collects `.test.ts` files under `src/` and nothing else; `components` takes
 * `.tsx`, and `integration` takes only `tests/integration`. Moved to
 * `scripts/` or the top of `tests/`,
 * this file is collected by no project — it would not fail, it would stop
 * running, and nothing would say so.
 *
 * THE DISCOVERY IS ASSERTED, NOT ASSUMED. A guard that finds no commands
 * reports no violations, which reads exactly like a healthy repository, so the
 * first test names the file whose install this exists to hold.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const WATCHED_DIRS = ['scripts', 'src/lib'] as const;

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

/**
 * The install-family spellings this guard recognises — NOT npm's full alias
 * set, which also has `in`, `ins`, `inst`, `isntall`, `upgrade` and a dozen
 * more. npm's namespace has no type to tether a roster against, so this is a
 * floor rather than a census: it covers what a contributor plausibly writes.
 */
const INSTALL_FAMILY = ['ci', 'install', 'add', 'update', 'i', 'up'] as const;

const INSTALL_COMMAND = new RegExp(`^npm\\s+(?:${INSTALL_FAMILY.join('|')})\\b`);

/** Flags are permitted — the rule is "installs from the lockfile", not a 7-character string. */
const LOCKFILE_INSTALL = /^npm\s+ci\b/;

const EXEC_CALLEES = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']);

interface Invocation {
  file: string;
  command: string;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** A string literal's text, for the two literal forms that carry no substitution. */
function literalText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

/** Pure over source text, so the cases at the bottom can feed it fixtures. */
export function installInvocationsIn(file: string, text: string): Invocation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Invocation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && EXEC_CALLEES.has(calleeName(node.expression) ?? '')) {
      const first = node.arguments[0];
      const program = first === undefined ? undefined : literalText(first);
      if (program !== undefined) {
        const argv = node.arguments[1];
        const parts =
          argv !== undefined && ts.isArrayLiteralExpression(argv)
            ? argv.elements.map(literalText).filter((part): part is string => part !== undefined)
            : [];
        const command = [program, ...parts].join(' ').trim();
        if (INSTALL_COMMAND.test(command)) found.push({ file, command });
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}

function watchedFiles(): string[] {
  return WATCHED_DIRS.flatMap((dir) =>
    readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' })
      .map((found) => `${dir}/${found.split(path.sep).join('/')}`)
      .filter((file) => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)))
      .filter((file) => !/\.test\.tsx?$/.test(file)),
  );
}

function installInvocations(): Invocation[] {
  return watchedFiles().flatMap((file) => installInvocationsIn(file, readFileSync(path.join(root, file), 'utf8')));
}

describe('every install this repo runs installs from the lockfile', () => {
  it('finds the file whose install this guard exists to hold', () => {
    // Names the file rather than asserting a non-empty set: a count is
    // satisfied forever by whichever install already passes, so it would stop
    // saying anything the day a second one is added. Reports lists, so a
    // failure says which half broke.
    expect({
      filesSearched: watchedFiles().length > 0,
      filesRunningAnInstall: installInvocations().map(({ file }) => file),
    }).toEqual({
      filesSearched: true,
      filesRunningAnInstall: ['scripts/worktree-setup.ts'],
    });
  });

  it('runs npm ci, never a command that resolves', () => {
    // Reports the offending invocations rather than a count, so a failure
    // names the file and the command it found.
    expect(installInvocations().filter(({ command }) => !LOCKFILE_INSTALL.test(command))).toEqual([]);
  });
});

describe('what the matcher does and does not treat as an invocation', () => {
  // These pin the properties the docblock claims. Without them the claims are
  // prose, and the loosening that breaks one of them passes the suite.
  it('reads the argv form, where the subcommand is not the first argument', () => {
    const source = "spawnSync('npm', ['install'], { stdio: 'inherit' });";
    expect(installInvocationsIn('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', command: 'npm install' },
    ]);
  });

  it('does not treat prose quoting a call as an invocation', () => {
    const source = ["// Never write execSync('npm install') here.", "execSync('npm ci');"].join('\n');
    expect(installInvocationsIn('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', command: 'npm ci' },
    ]);
  });

  it('permits flags on npm ci', () => {
    const source = "execSync('npm ci --ignore-scripts');";
    expect(installInvocationsIn('fixture.ts', source).filter(({ command }) => !LOCKFILE_INSTALL.test(command))).toEqual(
      [],
    );
  });

  it('does not read a command assembled by interpolation', () => {
    const source = 'execSync(`npm install ${extra}`);';
    expect(installInvocationsIn('fixture.ts', source)).toEqual([]);
  });
});
