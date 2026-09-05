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
 * syntax tree — a call expression whose callee names the helper, whether by its
 * own name, by a local name an import specifier binds to it, or as a member of
 * an imported namespace — so a mention of the name in a comment or a string is
 * not a call, and a call that never says `await` still is one. The verdict side
 * stays textual, because a comment convention has nowhere else to live. Neither
 * side is a search hoping the other agrees with it: one reads structure, the
 * other reads prose, and they are asserted to pair. The shell censuses of this
 * same set that ship elsewhere in the repo have blind spots of their own, and
 * those are measured in
 * `docs/superpowers/specs/2026-09-05-lock-verdict-census-tether-design.md`.
 *
 * HOW A CALL AND A VERDICT PAIR, ONE FOR ONE. Each call's nearest enclosing
 * statement must carry the marker in its LEADING COMMENT TRIVIA — above the
 * call, with nothing but comments in between — and that statement must hold
 * exactly one marker and exactly one call. The trivia run can be long, and a
 * verdict at the top of a long block still pairs. That looseness is the
 * convention rather than a gap in it: all it permits is a verdict separated
 * from its call by comments. The two counts are what keep the pairing from
 * degrading into a pool. A second marker over one call is a verdict standing
 * over nothing — copied in, or left behind by a deleted neighbour whose orphan
 * comment merged into the survivor's trivia run. A second call under one marker
 * is one verdict asked to answer for two transactions' worth of lock scope,
 * which it cannot honestly do.
 *
 * WHAT IT DOES NOT SEE, so that a call site landing there is nobody's failure
 * here. `src/lib/db-locks.ts` is excluded: it defines the helper, so a call in
 * it would be self-referential, and it is where the convention is stated and
 * where the re-derivation command lives, so its marker text belongs to no call.
 * Test files are excluded because their calls exercise the helper rather than
 * opening a domain transaction — there is no entry-column question for a
 * verdict to answer. Nothing under `tests/` is searched at all.
 *
 * A call that reaches the helper through a local binding — `const f =
 * lockClassRowsOrdered; f(tx, …)` — is not seen either. Resolving one needs a
 * full type-checker program, which this test does not build. An import alias
 * and a namespace member are followed; a local indirection is not.
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

/**
 * The local names that reach the helper in one file: its own, plus whatever an
 * import specifier binds it to (`import { lockClassRowsOrdered as X }`).
 *
 * Only from a module specifier whose last segment is `db-locks`, so a same-named
 * export from an unrelated module is not swept in. Its own name stays in the set
 * unconditionally, and that is belt and braces rather than redundancy: a call
 * reaching the helper by some route this scan does not model is still caught by
 * its name.
 */
function helperNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set([HELPER]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/(^|\/)db-locks$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.propertyName?.text === HELPER) names.add(element.name.text);
    }
  }
  return names;
}

/**
 * A call reaching the helper. Either the callee is one of the file's local
 * names for it, or it is a property access whose name is the helper —
 * `ns.lockClassRowsOrdered` after an `import * as ns`. The property-access arm
 * is deliberately not qualified by what `ns` is: reading a member of that name
 * off anything is close enough to a call to be worth a verdict.
 */
function isHelperCall(node: ts.Node, names: ReadonlySet<string>): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return names.has(node.expression.text);
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === HELPER;
}

interface Site {
  readonly file: string;
  readonly line: number;
}

/** One statement enclosing at least one call, with what pairs against it. */
interface CallSite extends Site {
  readonly calls: number;
  readonly verdicts: number;
}

interface Census {
  readonly callSites: readonly CallSite[];
  readonly verdicts: readonly (Site & { readonly paired: boolean })[];
}

/**
 * The nearest statement enclosing a node. A `SourceFile`'s own children are all
 * statements, so the walk is believed always to reach one; the `undefined`
 * fallback stays because removing it would take a type assertion. Such a call
 * counts as unverdicted rather than skipped, so a case believed unreachable
 * cannot become a silent pass.
 */
function nearestStatement(node: ts.Node): ts.Statement | undefined {
  let current = node.parent;
  while (!ts.isSourceFile(current)) {
    if (ts.isStatement(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/** Whether a marker occurrence falls inside any of a set of comment ranges. */
function inAnyOf(ranges: readonly ts.CommentRange[], at: number): boolean {
  return ranges.some((range) => range.pos <= at && at < range.end);
}

function takeCensus(): Census {
  const callSites: CallSite[] = [];
  const verdicts: (Site & { paired: boolean })[] = [];

  for (const file of searchScope()) {
    const text = readFileSync(path.join(root, file), 'utf8');
    // The real path is the file name, so `.tsx` parses as TSX rather than as
    // TypeScript reading `<Foo>` as a type assertion. `true` sets parent
    // pointers, which `nearestStatement` walks.
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
    const names = helperNames(source);

    const markers: number[] = [];
    for (let at = text.indexOf(MARKER); at !== -1; at = text.indexOf(MARKER, at + 1)) {
      markers.push(at);
    }

    // Calls grouped by the statement enclosing them, so one statement's trivia
    // answers for the calls in that statement and for no others. Grouping is
    // what makes the pairing one-to-one instead of a pool: two calls under one
    // marker arrive here as a single entry counting two.
    const grouped = new Map<ts.Statement, { count: number; line: number }>();
    const unenclosed: { count: number; line: number }[] = [];

    const visit = (node: ts.Node): void => {
      if (isHelperCall(node, names)) {
        const line = lineOf(node.getStart(source));
        const statement = nearestStatement(node);
        if (statement === undefined) {
          unenclosed.push({ count: 1, line });
        } else {
          // The walk is in source order, so the line kept is the first call's.
          const seen = grouped.get(statement);
          grouped.set(statement, { count: (seen?.count ?? 0) + 1, line: seen?.line ?? line });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);

    const groups: { statement: ts.Statement | undefined; count: number; line: number }[] = [
      ...[...grouped].map(([statement, group]) => ({ statement, ...group })),
      ...unenclosed.map((group) => ({ statement: undefined, ...group })),
    ];

    // Leading trivia of every statement that encloses a call — whether or not
    // it holds a verdict. A marker outside all of these is a verdict attached
    // to no call, which is the orphan direction below.
    const pairedRanges: ts.CommentRange[] = [];

    for (const group of groups) {
      const ranges =
        group.statement === undefined
          ? []
          : (ts.getLeadingCommentRanges(text, group.statement.getFullStart()) ?? []);
      pairedRanges.push(...ranges);
      callSites.push({
        file,
        line: group.line,
        calls: group.count,
        verdicts: markers.filter((at) => inAnyOf(ranges, at)).length,
      });
    }

    for (const at of markers) {
      verdicts.push({
        file,
        line: lineOf(at),
        // Inside a paired range, or nowhere that counts. A marker in a string
        // literal falls in no comment range at all and lands here too.
        paired: inAnyOf(pairedRanges, at),
      });
    }
  }

  return { callSites, verdicts };
}

/** Sorted the way a reader would open them, so a failure list is stable. */
function byLocation<T extends Site>(sites: readonly T[]): T[] {
  return [...sites].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );
}

/** `path:line`, so a failure is a place a reader can open. */
function label(site: Site): string {
  return `${site.file}:${site.line}`;
}

/** `1 call` / `2 calls`, so the reason reads as English inside the location. */
function tally(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
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
    const { callSites, verdicts } = takeCensus();
    expect({ foundACall: callSites.length > 0, foundAVerdict: verdicts.length > 0 }).toEqual({
      foundACall: true,
      foundAVerdict: true,
    });
  });

  it('pairs every call with one verdict above it, and every verdict with a call', () => {
    const { callSites, verdicts } = takeCensus();

    // Both directions in one assertion, so a failure names which way it broke
    // rather than reporting two sorted arrays and leaving the reader to diff.
    // The counts ride inside the location string for the same reason: `(2
    // calls, 1 verdict)` says which shape it is without opening this file.
    expect({
      callSitesNotPairedOneToOne: byLocation(
        callSites.filter((site) => site.calls !== 1 || site.verdicts !== 1),
      ).map(
        (site) =>
          `${label(site)} (${tally(site.calls, 'call')}, ${tally(site.verdicts, 'verdict')})`,
      ),
      verdictsWithoutCall: byLocation(verdicts.filter((verdict) => !verdict.paired)).map(label),
    }).toEqual({ callSitesNotPairedOneToOne: [], verdictsWithoutCall: [] });
  });
});
