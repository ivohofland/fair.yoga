/**
 * Every install this repo's own code runs installs from the lockfile.
 *
 * `pnpm install --frozen-lockfile` installs the lockfile exactly and fails
 * when `package.json` disagrees with it. A bare `pnpm install` reconciles
 * instead: it may resolve a range afresh against the registry, and it may
 * rewrite the lockfile. Code that bootstraps a checkout wants the first
 * behaviour — the versions someone committed, or a loud failure — and this
 * file is what makes that a failing build rather than a review note.
 *
 * THE FLAG IS DEMANDED EXPLICITLY even though pnpm turns it on by default
 * when `CI` is set. Leaning on that default would leave one command frozen
 * on a runner and reconciling on a laptop — the same class of failure as a
 * setting that is accepted and quietly not applied, which is what this
 * repo's supply-chain rule exists to prevent (docs/supply-chain.md).
 *
 * WHAT IT READS. Call expressions under `scripts/` and `src/lib/`, parsed with
 * `ts.createSourceFile` as the sibling censuses do. A call counts when its
 * callee NAME is one of `EXEC_CALLEES`; the command is then rebuilt from the
 * first string argument plus, where the second argument is an array literal,
 * whichever of its elements are string literals — a non-literal element is
 * dropped rather than disqualifying the call, so a part-computed command is
 * judged on the part that can be read. That second half matters: `spawnSync`,
 * `spawn`, `execFile` and `execFileSync` take the program and its arguments
 * separately, so `spawnSync('pnpm', ['install', '--frozen-lockfile'])` carries
 * its subcommand outside the first argument. Reading only the first would
 * leave those four matchable only in their `shell: true` form, where the
 * whole command line is the first argument after all. The argv shape is this
 * repo's own — `worktree/dev-server.ts` uses it for `pnpm exec` — though that
 * particular call is doubly invisible here, its callee both renamed and
 * injected.
 *
 * WHAT IT CANNOT SEE, measured rather than assumed:
 *   - a renamed or injected callee (`import { execSync as run }`, or an
 *     `execFn` parameter) — matching is by name, and nothing resolves the
 *     binding back to `child_process`, so a same-named helper counts too;
 *   - a command assembled by interpolation or held in a variable;
 *   - a command whose `pnpm` is not immediately followed by the subcommand,
 *     whether behind another command (`cd x && pnpm install`) or behind a
 *     global flag (`pnpm --dir x install`) — the pattern is anchored and
 *     reads only the token after `pnpm`;
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
 * `.test.ts` AND `.test.tsx` FILES ARE EXCLUDED, because a fixture asserting
 * what the guard catches has to contain the very shapes it catches — the cases
 * at the bottom of this file would otherwise fail it. Other test spellings
 * (`.spec.ts`, a `.test.mjs`) are not excluded and none exists here.
 *
 * WHY THIS FILE LIVES IN `src/lib/`. No project in `vitest.config.ts` collects
 * `scripts/` or the top of `tests/`. Moved to either, this file is collected by
 * nothing — it would not fail, it would stop running, and nothing would say so.
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
 * The install-family spellings this guard recognises — NOT pnpm's full alias
 * set. pnpm's namespace has no type to tether a roster against, so this is a
 * floor rather than a census: it covers what a contributor plausibly writes.
 */
const INSTALL_FAMILY = ['install', 'i', 'add', 'update', 'up', 'import'] as const;

const INSTALL_COMMAND = new RegExp(`^pnpm\\s+(?:${INSTALL_FAMILY.join('|')})\\b`);

/**
 * pnpm's lockfile-exact install is `pnpm install --frozen-lockfile` — a
 * FLAG, not a subcommand, so unlike `npm ci` no anchored prefix can express
 * it. Both halves are required: the install family at the front, and the
 * flag somewhere after it.
 *
 * THE FLAG IS DEMANDED EXPLICITLY even though pnpm turns it on by default
 * when `CI` is set. Leaning on that default would leave one command frozen
 * on a runner and reconciling on a laptop — the same class of failure as a
 * setting that is accepted and quietly not applied, which is what this
 * repo's supply-chain rule exists to prevent (docs/supply-chain.md).
 */
function isLockfileInstall(command: string): boolean {
  return (
    /^pnpm\s+(?:install|i)\b/.test(command) &&
    /(?:^|\s)--frozen-lockfile(?=\s|$)/.test(command)
  );
}

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

  it('runs pnpm install --frozen-lockfile, never a command that resolves', () => {
    // Reports the offending invocations rather than a count, so a failure
    // names the file and the command it found.
    expect(installInvocations().filter(({ command }) => !isLockfileInstall(command))).toEqual([]);
  });
});

describe('what the matcher does and does not treat as an invocation', () => {
  // These pin the properties the docblock claims. Without them the claims are
  // prose, and the loosening that breaks one of them passes the suite.
  it('reads the argv form, where the subcommand is not the first argument', () => {
    const source = "spawnSync('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit' });";
    expect(installInvocationsIn('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', command: 'pnpm install --frozen-lockfile' },
    ]);
  });

  it('does not treat prose quoting a call as an invocation', () => {
    const source = [
      "// Never write execSync('pnpm install') here.",
      "execSync('pnpm install --frozen-lockfile');",
    ].join('\n');
    expect(installInvocationsIn('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', command: 'pnpm install --frozen-lockfile' },
    ]);
  });

  it('permits further flags alongside --frozen-lockfile', () => {
    const source = "execSync('pnpm install --frozen-lockfile --ignore-scripts');";
    expect(
      installInvocationsIn('fixture.ts', source).filter(({ command }) => !isLockfileInstall(command)),
    ).toEqual([]);
  });

  // The assertion npm's shape could not need: `npm ci` was lockfile-exact by
  // its own name, so there was nothing to omit. A bare `pnpm install`
  // resolves, and is frozen only by an environment variable this repo does
  // not control on a contributor's machine.
  it('treats a bare pnpm install as a violation', () => {
    const source = "execSync('pnpm install');";
    expect(
      installInvocationsIn('fixture.ts', source).filter(({ command }) => !isLockfileInstall(command)),
    ).toEqual([{ file: 'fixture.ts', command: 'pnpm install' }]);
  });

  it('does not read a command assembled by interpolation', () => {
    const source = 'execSync(`pnpm install --frozen-lockfile ${extra}`);';
    expect(installInvocationsIn('fixture.ts', source)).toEqual([]);
  });

  // The two below pin blind spots rather than behaviour, which is the point:
  // the docblock claims them, and a matcher widened to catch either must
  // update that list in the same commit or turn this file red.
  it('does not see a renamed or injected callee', () => {
    const source = ["run('pnpm install');", "installFn('pnpm install');"].join('\n');
    expect(installInvocationsIn('fixture.ts', source)).toEqual([]);
  });

  it('does not see a command whose pnpm is not immediately followed by the subcommand', () => {
    const source = [
      "execSync('cd packages/x && pnpm install --frozen-lockfile');",
      "execSync('pnpm --dir packages/x install --frozen-lockfile');",
    ].join('\n');
    expect(installInvocationsIn('fixture.ts', source)).toEqual([]);
  });
});
