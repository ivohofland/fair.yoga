/**
 * Every `lockClassRowsOrdered` call site carries a verdict, and every verdict
 * has a call site under it.
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT. It does not decide whether a
 * verdict is RIGHT. Whether the transaction around a call really does touch
 * the entry's `date`, `startTime`, `durationMinutes` or `cancelledAt` — and so
 * whether `entries: true` belongs there — is a judgement about a whole
 * transaction that a person makes by reading it; nothing mechanical can. Nor
 * does this ask a call site for a decoy proving its own scoping conjunct. What
 * it stops is narrower and is the thing prose could not hold on its own: a call
 * site shipping with the question never answered in writing, and a verdict left
 * standing over a call that is gone.
 *
 * TWO CENSUSES, DELIBERATELY UNLIKE EACH OTHER. The call side is read from the
 * syntax tree — a call expression whose callee is the helper's identifier — so
 * a mention of the name in a comment or a string is not a call, and a call that
 * never says `await` still is one. The verdict side stays textual, because a
 * comment convention has nowhere else to live. Neither side is a search hoping
 * the other agrees with it: one reads structure, the other reads prose, and
 * they are asserted to pair. Both blind spots of the two shell commands this
 * replaces were measured in
 * `docs/superpowers/specs/2026-09-05-lock-verdict-census-tether-design.md`.
 *
 * HOW A CALL AND A VERDICT PAIR. Each call's nearest enclosing statement must
 * carry the marker in its LEADING COMMENT TRIVIA — above the call, with nothing
 * but comments in between. That run can be long, and a verdict at the top of a
 * long block still pairs. The looseness is the convention rather than a gap in
 * it: all it permits is a verdict separated from its call by comments. A second
 * call site cannot borrow the first's verdict, because the second statement's
 * leading trivia begins where the first statement ended.
 *
 * WHAT IT DOES NOT SEE, so that a call site landing there is nobody's failure
 * here. `src/lib/db-locks.ts` is excluded: it defines the helper, so a call in
 * it would be self-referential, and it is where the convention is stated and
 * where the re-derivation command lives, so its marker text belongs to no call.
 * Test files are excluded because their calls exercise the helper rather than
 * opening a domain transaction — there is no entry-column question for a
 * verdict to answer. Nothing under `tests/` is searched at all.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Assembled rather than written out, so a marker in this file's own text
 * cannot be mistaken for a verdict standing over nothing.
 *
 * The `*.test.ts` exclusion in `searchScope` already keeps this file out of
 * the search; assembling it means that exclusion is not the only thing
 * standing between the test and reporting itself. Inlined as one literal it
 * would break quietly, because the exclusion would go on hiding it.
 */
const MARKER = ['VERDICT', '(#327)'].join(' ');

/**
 * The helper's name appears here only as data. A string literal is not a call
 * expression, so nothing in this file can enter the call census even with the
 * exclusion above lifted — the same self-exclusion as `MARKER`, reached a
 * different way because this census reads syntax rather than text.
 */
const HELPER = 'lockClassRowsOrdered';

/** Where the helper and the convention live. Excluded from the search below. */
const DEFINING_MODULE = 'src/lib/db-locks.ts';

const root = process.cwd();

/**
 * Every `.ts`/`.tsx` under `src/`, repo-relative, minus the test files and
 * minus the defining module. Directories fall out on the extension filter.
 */
function searchScope(): string[] {
  return readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .map((p) => `src/${p.split(path.sep).join('/')}`)
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && p !== DEFINING_MODULE)
    .sort();
}

interface Site {
  readonly file: string;
  readonly line: number;
}

interface Census {
  readonly calls: readonly (Site & { readonly verdicted: boolean })[];
  readonly verdicts: readonly (Site & { readonly paired: boolean })[];
}

/**
 * The nearest statement enclosing a node, or `undefined` if the walk reaches
 * the file without finding one. Undefined is not "skip": a call with no
 * enclosing statement has no leading trivia to carry a verdict, so it counts
 * as unverdicted and says so by name.
 */
function nearestStatement(node: ts.Node): ts.Statement | undefined {
  let current = node.parent;
  while (!ts.isSourceFile(current)) {
    if (ts.isStatement(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function takeCensus(): Census {
  const calls: (Site & { verdicted: boolean })[] = [];
  const verdicts: (Site & { paired: boolean })[] = [];

  for (const file of searchScope()) {
    const text = readFileSync(path.join(root, file), 'utf8');
    // The real path is the file name, so `.tsx` parses as TSX rather than as
    // TypeScript reading `<Foo>` as a type assertion. `true` sets parent
    // pointers, which `nearestStatement` walks.
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;

    // Leading trivia of every statement that encloses a call — whether or not
    // it holds a verdict. A marker outside all of these is a verdict attached
    // to no call, which is the orphan direction below.
    const pairedRanges: ts.CommentRange[] = [];

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === HELPER
      ) {
        const statement = nearestStatement(node);
        const ranges =
          statement === undefined
            ? []
            : (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []);
        pairedRanges.push(...ranges);
        calls.push({
          file,
          line: lineOf(node.getStart(source)),
          verdicted: ranges.some((range) => text.slice(range.pos, range.end).includes(MARKER)),
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);

    for (let at = text.indexOf(MARKER); at !== -1; at = text.indexOf(MARKER, at + 1)) {
      verdicts.push({
        file,
        line: lineOf(at),
        // Inside a paired range, or nowhere that counts. A marker in a string
        // literal falls in no comment range at all and lands here too.
        paired: pairedRanges.some((range) => range.pos <= at && at < range.end),
      });
    }
  }

  return { calls, verdicts };
}

/** `path:line`, sorted, so a failure is a place a reader can open. */
function locations(sites: readonly Site[]): string[] {
  return [...sites]
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
    .map((site) => `${site.file}:${site.line}`);
}

describe('every lockClassRowsOrdered call site carries a verdict', () => {
  it('runs where the module that defines the convention is', () => {
    // First, so a rename or a wrong working directory is named once here
    // rather than inferred. It prevents nothing — the exclusion is keyed on
    // this path, so a renamed module rejoins the search and the marker text in
    // its convention statement and its re-derivation command surfaces as
    // orphan verdicts with no visible cause. This guard makes that failure say
    // what it is.
    expect(existsSync(path.join(root, DEFINING_MODULE))).toBe(true);
  });

  it('finds both censuses non-empty', () => {
    // Before the pairing, because the pairing passes vacuously on two empty
    // sets: a file walk that stops matching anything reports no unverdicted
    // call and no orphan verdict, which is indistinguishable from a healthy
    // tree. This is the assertion that tells them apart.
    const { calls, verdicts } = takeCensus();
    expect({ foundACall: calls.length > 0, foundAVerdict: verdicts.length > 0 }).toEqual({
      foundACall: true,
      foundAVerdict: true,
    });
  });

  it('pairs every call with a verdict above it, and every verdict with a call', () => {
    const { calls, verdicts } = takeCensus();

    // Both directions in one assertion, so a failure names which way it broke
    // rather than reporting two sorted arrays and leaving the reader to diff.
    expect({
      callsWithoutVerdict: locations(calls.filter((call) => !call.verdicted)),
      verdictsWithoutCall: locations(verdicts.filter((verdict) => !verdict.paired)),
    }).toEqual({ callsWithoutVerdict: [], verdictsWithoutCall: [] });
  });
});
