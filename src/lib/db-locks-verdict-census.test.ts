/**
 * Every `lockClassRowsOrdered` call site carries a verdict, and every verdict
 * has a call site under it.
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT. It does not decide whether a
 * verdict is RIGHT. Whether the transaction around a call really does read or
 * write the entry columns `entries: true` is about — the set named on
 * `ClassLockSource.entries` in `db-locks.ts` — is a judgement about a whole
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
 * COMMENT ANCHOR — the nearest statement, or the nearest object-literal or class
 * member — must carry the marker in its leading comment trivia, and must hold
 * exactly one marker and exactly one call. The anchor is the unit a person
 * writes a comment above, which is why it is not simply the nearest statement:
 * a call inside `withdraw: (tx) => lock(tx, …)` takes its verdict from the
 * comment above `withdraw`, not from one above the whole `export const` the
 * object sits in — and a verdict above that `export const`, twenty members away,
 * pairs with nothing.
 *
 * The trivia run above an anchor can be long, and a verdict at the top of one
 * still pairs; all that permits is a verdict separated from its anchor by
 * comments. The two counts are what keep the pairing from degrading into a pool.
 * A second marker over one anchor is a verdict standing over nothing — copied
 * in, or left behind by a deleted neighbour whose orphan comment merged into the
 * survivor's trivia run. A second call under one marker is refused not because
 * the two calls are necessarily in different transactions (inside one anchor
 * they usually are not) but because one comment cannot be read as the answer for
 * two lock scopes without a reader guessing which; splitting them is cheap and
 * makes the author look at the second.
 *
 * A CONSEQUENCE WORTH KNOWING BEFORE IT BITES: a verdict above an enclosing
 * `if`, `try`, `$transaction(…)` call or function docblock does not pair — the
 * anchor is the call's own, not its container's. Such a verdict is reported
 * twice, as an unverdicted call and as an orphan verdict. `db-locks.ts`'s
 * `entries` docblock is where the placement rule is stated for authors.
 *
 * WHAT IT DOES NOT SEE, so that a call site landing there is nobody's failure
 * here. `src/lib/db-locks.ts` is excluded: it defines the helper, so a call in
 * it would be self-referential, and it is where the convention is stated and
 * where the re-derivation command lives, so its marker text belongs to no call.
 * Test files are excluded because their calls exercise the helper rather than
 * opening a domain transaction — there is no entry-column question for a
 * verdict to answer. Nothing outside `src/` is searched at all: not `tests/`,
 * not `prisma/seed.ts`, not `scripts/`, not the root-level configs. Nor is a
 * source `tsconfig` compiles but this walk does not match — `allowJs` is on and
 * `*.mts` is included, so such a file under `src/` would be invisible here.
 *
 * The census also assumes its files parse. `ts.createSourceFile` does not throw
 * and reports no diagnostics here, so a syntax error that swallows a call
 * censuses zero calls quietly. `npm run typecheck` in CI's `checks` job is what
 * holds that, which makes this defence in depth rather than a hole.
 *
 * THE MARKER IS A RESERVED TOKEN. Any occurrence of it in a searched file counts
 * as a verdict, including one inside prose that merely refers to somebody else's
 * — so a cross-reference has to name the convention without spelling the marker.
 * This file keeps itself out by assembling `MARKER` below; `db-locks.ts` is kept
 * out by path.
 *
 * A call that reaches the helper through a local binding — `const f =
 * lockClassRowsOrdered; f(tx, …)` — is not seen. Resolving one needs a full
 * type-checker program, which this test does not build; nor are the two shapes
 * that hide the name behind an expression, `(0, lockClassRowsOrdered)(…)` and
 * `(cond ? lockClassRowsOrdered : other)(…)`. A namespace member is followed by
 * name, and an import alias is followed only from a specifier naming
 * `db-locks`, so one reached through a re-exporting barrel is not.
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
 *
 * `satisfies` is what keeps it honest through a rename. Without it the census
 * would simply stop finding calls and go red as `foundACall: false` plus one
 * orphan verdict per surviving call site, naming nothing; with it the compiler
 * refuses the file and lists the module's real exports. That is the
 * *Comment Discipline* rule "where
 * membership matters, tether it to the compiler", and the import is a type
 * position, so it erases and adds no runtime dependency.
 */
const HELPER = 'lockClassRowsOrdered' satisfies keyof typeof import('./db-locks');

/** Where the helper and the convention live. Excluded from the search below. */
const DEFINING_MODULE = 'src/lib/db-locks.ts';

const root = process.cwd();

/** Repo-relative paths of every `.ts`/`.tsx` under `src/`, test files included. */
function typeScriptUnderSrc(): string[] {
  return readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .map((p) => `src/${p.split(path.sep).join('/')}`)
    .filter((p) => /\.tsx?$/.test(p))
    .sort();
}

/**
 * Every `.ts`/`.tsx` under `src/`, repo-relative, minus the test files and
 * minus the defining module. Directories fall out on the extension filter.
 */
function searchScope(): string[] {
  return typeScriptUnderSrc().filter((p) => !/\.test\.tsx?$/.test(p) && p !== DEFINING_MODULE);
}

/**
 * A SECOND read of `src/`, for the scope-reach guard alone. What that guard
 * checks against this is the census's own list of files consumed, and this
 * reaches no line of anything that produces it — not `typeScriptUnderSrc`, not
 * `searchScope`, not `censusOfTree`, not their shared walk. It makes its own
 * `readdirSync` call rather than reaching theirs, which means their options
 * object and this one must stay in step; a difference there narrows this side
 * alone, and the guard's second direction is what reports that.
 *
 * The duplication is the whole point. A guard whose two sides come from one
 * function narrows in lockstep with it: a filter added inside that function
 * drops an area from the census AND from the guard's expectation in the same
 * edit, and the comparison stays equal. Only the extension and test-file rules
 * are duplicated here; no exclusion a future edit adds to `searchScope` reaches
 * this, which is exactly what has to make the two disagree.
 *
 * `DEFINING_MODULE` is deliberately among those not duplicated: an area whose
 * only production file is the one that exclusion removes is a hole this guard
 * should report rather than bless.
 */
function areasUnderSrc(): Set<string> {
  const areas = new Set<string>();
  for (const found of readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })) {
    const relative = found.split(path.sep).join('/');
    if (!/\.tsx?$/.test(relative) || /\.test\.tsx?$/.test(relative)) continue;
    areas.add(relative.split('/')[0] ?? relative);
  }
  return areas;
}

/**
 * The first path segment under `src/` — `services`, `app`, or a bare filename
 * for something sitting directly in `src/`. What the scope-reach assertion
 * compares, and the granularity it can hold: a narrowing that thins an area
 * without emptying it is invisible to that assertion, which says so itself.
 */
function areaOf(file: string): string {
  return file.slice('src/'.length).split('/')[0] ?? file;
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
  const names = new Set<string>([HELPER]);
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

/** Wrappers that leave a callee's identity unchanged: `(f)(…)` and `f!(…)`. */
function unwrapCallee(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * A call reaching the helper: the callee is one of the file's local names for
 * it, or a property access or string-keyed element access whose name is the
 * helper — `ns.lockClassRowsOrdered` or `ns['lockClassRowsOrdered']` after an
 * `import * as ns`.
 *
 * Those last two arms are deliberately not qualified by what `ns` is. Reading a
 * member of that name off anything is close enough to a call to be worth a
 * verdict, and the direction of the error matters: over-including can only
 * demand a verdict where none is owed, which is loud, while under-including
 * hides a call site, which is the failure this whole file exists to prevent.
 */
function isHelperCall(node: ts.Node, names: ReadonlySet<string>): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrapCallee(node.expression);
  if (ts.isIdentifier(callee)) return names.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === HELPER;
  return (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    callee.argumentExpression.text === HELPER
  );
}

/**
 * A node a person writes a comment above: a statement, or a member of an object
 * literal or a class body. Members matter because a call in a concise-body
 * arrow (`withdraw: (tx) => lock(tx, …)`) has no statement of its own, and
 * anchoring it on the enclosing `const` would both reject the verdict written
 * directly above it and accept one written twenty members away.
 */
function isCommentAnchor(node: ts.Node): boolean {
  if (ts.isStatement(node)) return true;
  const parent: ts.Node | undefined = node.parent;
  return parent !== undefined && (ts.isObjectLiteralExpression(parent) || ts.isClassLike(parent));
}

/**
 * The nearest anchor enclosing a node. A `SourceFile`'s own children are all
 * statements, so the walk is believed always to reach one; the `undefined`
 * fallback stays because removing it would take a type assertion. Such a call
 * counts as unverdicted rather than skipped, so a case believed unreachable
 * cannot become a silent pass.
 */
function nearestAnchor(node: ts.Node): ts.Node | undefined {
  let current: ts.Node = node.parent;
  while (!ts.isSourceFile(current)) {
    if (isCommentAnchor(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/** Whether a marker occurrence falls inside any of a set of comment ranges. */
function inAnyOf(ranges: readonly ts.CommentRange[], at: number): boolean {
  return ranges.some((range) => range.pos <= at && at < range.end);
}

interface Site {
  readonly file: string;
  readonly line: number;
}

/** One anchor enclosing at least one call, with what pairs against it. */
interface CallSite extends Site {
  readonly calls: number;
  readonly verdicts: number;
}

interface Census {
  readonly callSites: readonly CallSite[];
  readonly verdicts: readonly (Site & { readonly paired: boolean })[];
  /**
   * Every source consumed, repo-relative, recorded by the loop that reads it.
   * The scope-reach guard derives its `reached` set from this rather than from
   * a second call to the walk, so a filter inserted between the walk and this
   * census narrows `reached` with it and the guard reports the difference.
   */
  readonly filesCensused: readonly string[];
}

/** A file to census: its repo-relative path, and its text. */
interface Source {
  readonly file: string;
  readonly text: string;
}

/**
 * Taken over supplied sources rather than off disk, so the pairing rules can be
 * exercised against shapes this repository does not currently contain. Every
 * arm below is dead weight under the real tree, which holds exactly one call
 * shape — that is what the fixtures at the bottom of this file are for.
 */
function takeCensus(sources: readonly Source[]): Census {
  const callSites: CallSite[] = [];
  const verdicts: (Site & { paired: boolean })[] = [];
  const filesCensused: string[] = [];

  for (const { file, text } of sources) {
    // Recorded here, by the loop that consumes the source, and not off the
    // `sources` parameter before it: there is then no step between what this
    // list says was read and what was read.
    filesCensused.push(file);

    // The real path is the file name, so `.tsx` parses as TSX rather than as
    // TypeScript reading `<Foo>` as a type assertion. `true` sets parent
    // pointers, which `nearestAnchor` walks.
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
    const names = helperNames(source);

    const markers: number[] = [];
    for (let at = text.indexOf(MARKER); at !== -1; at = text.indexOf(MARKER, at + 1)) {
      markers.push(at);
    }

    // Calls grouped by the anchor enclosing them, so one anchor's trivia
    // answers for the calls under it and for no others. Grouping is what makes
    // the pairing one-to-one instead of a pool: two calls under one marker
    // arrive here as a single entry counting two.
    const grouped = new Map<ts.Node, { count: number; line: number }>();
    const unanchored: { count: number; line: number }[] = [];

    const visit = (node: ts.Node): void => {
      if (isHelperCall(node, names)) {
        const line = lineOf(node.getStart(source));
        const anchor = nearestAnchor(node);
        if (anchor === undefined) {
          unanchored.push({ count: 1, line });
        } else {
          // The walk is in source order, so the line kept is the first call's.
          const seen = grouped.get(anchor);
          grouped.set(anchor, { count: (seen?.count ?? 0) + 1, line: seen?.line ?? line });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);

    const groups: { anchor: ts.Node | undefined; count: number; line: number }[] = [
      ...[...grouped].map(([anchor, group]) => ({ anchor, ...group })),
      ...unanchored.map((group) => ({ anchor: undefined, ...group })),
    ];

    // Leading trivia of every anchor enclosing a call — whether or not it holds
    // a verdict. A marker outside all of these is a verdict attached to no
    // call, which is the orphan direction below.
    const pairedRanges: ts.CommentRange[] = [];

    for (const group of groups) {
      const ranges =
        group.anchor === undefined
          ? []
          : (ts.getLeadingCommentRanges(text, group.anchor.getFullStart()) ?? []);
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

  return { callSites, verdicts, filesCensused };
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

/**
 * The two failure lists, in the shape the assertions compare. Shared by the
 * real-tree assertion and the fixtures below, so the fixtures pin the reported
 * strings and not merely the internal counts.
 */
function findings(census: Census): {
  callSitesNotPairedOneToOne: string[];
  verdictsWithoutCall: string[];
} {
  return {
    callSitesNotPairedOneToOne: byLocation(
      census.callSites.filter((site) => site.calls !== 1 || site.verdicts !== 1),
    ).map(
      (site) => `${label(site)} (${tally(site.calls, 'call')}, ${tally(site.verdicts, 'verdict')})`,
    ),
    verdictsWithoutCall: byLocation(census.verdicts.filter((v) => !v.paired)).map(label),
  };
}

const CLEAN = { callSitesNotPairedOneToOne: [], verdictsWithoutCall: [] };

/**
 * Read once and shared, so the assertions below cannot disagree about what the
 * tree held: taking a census each let the guard bless one the pairing never
 * saw, and left the walk paying for the tree twice.
 *
 * It does NOT stop the pairing assertion passing on an empty census — measured:
 * with the scope emptied it still reports a green tick, because no unverdicted
 * call and no orphan verdict is exactly what an empty tree yields. The two
 * assertions below are what catch that, and they are the reason the pairing one
 * is allowed to stay as simple as it is.
 */
let treeCensus: Census | undefined;
function censusOfTree(): Census {
  return (treeCensus ??= takeCensus(
    searchScope().map((file) => ({ file, text: readFileSync(path.join(root, file), 'utf8') })),
  ));
}

describe('every lockClassRowsOrdered call site carries a verdict', () => {
  it('runs where the module that defines the convention is', () => {
    // First, so a rename or a wrong working directory is named once here
    // rather than inferred. It prevents nothing — the exclusion is keyed on
    // this path, so a renamed module rejoins the search and the marker text in
    // its convention statement and its re-derivation command surfaces as
    // orphan verdicts with no visible cause. This guard makes that failure say
    // what it is, which is why it reports the path rather than a bare boolean.
    const missing = existsSync(path.join(root, DEFINING_MODULE)) ? [] : [DEFINING_MODULE];
    expect({ missing }).toEqual({ missing: [] });
  });

  it('reaches every area of src that holds production TypeScript', () => {
    // The non-vacuity assertion below checks two TOTALS, which stay non-zero
    // as long as one call and one verdict survive anywhere the census searches.
    // So a filter edit that drops whole directories leaves both totals non-zero
    // and every assertion green while the census stops watching most of the
    // repository.
    //
    // `areasUnderSrc` reads the directory itself rather than calling the walk,
    // so a narrowing that empties an area disagrees with it wherever the
    // narrowing sits: inside the shared `typeScriptUnderSrc`, inside
    // `searchScope`, or between the walk and `takeCensus` at `censusOfTree`'s
    // call site. That last one is why `reached` is the census's own
    // `filesCensused` and not a second call to the walk — the census names the
    // files it consumed, so nothing narrowing it leaves this side whole.
    //
    // The granularity is the area and no finer, as this test's name says: a
    // narrowing leaving an area even one CENSUSED production file passes here.
    // Censused is the load-bearing word — an area left holding only the
    // excluded defining module has nothing in `reached` and does go red.
    //
    // Both directions, so a failure names which side moved. The second stays
    // empty while the census consumes a subset of `searchScope`, since
    // `areasUnderSrc` applies a strict subset of `searchScope`'s rules to the
    // same tree — so an area the census reaches is one it requires. What can
    // now fire it, and could not while this side re-read the walk, is a census
    // consuming a file `areasUnderSrc` would not require — a source list
    // widened past the walk. Short of that it costs nothing until
    // `areasUnderSrc` itself narrows, and a narrowing there shrinks the very
    // difference the first direction asserts empty.
    const required = areasUnderSrc();
    const reached = new Set(censusOfTree().filesCensused.map(areaOf));
    expect({
      areasTheCensusMisses: [...required].filter((area) => !reached.has(area)).sort(),
      areasTheGuardMisses: [...reached].filter((area) => !required.has(area)).sort(),
    }).toEqual({ areasTheCensusMisses: [], areasTheGuardMisses: [] });
  });

  it('excludes the test files and the defining module, neither of them vacuously', () => {
    const scope = searchScope();
    expect({
      testFilesInScope: scope.filter((p) => /\.test\.tsx?$/.test(p)),
      definingModuleInScope: scope.filter((p) => p === DEFINING_MODULE),
      // Both exclusions would also be satisfied by a tree containing neither
      // kind of file, which is a different thing entirely.
      testFilesOnDisk: typeScriptUnderSrc().some((p) => /\.test\.tsx?$/.test(p)),
      definingModuleOnDisk: typeScriptUnderSrc().includes(DEFINING_MODULE),
    }).toEqual({
      testFilesInScope: [],
      definingModuleInScope: [],
      testFilesOnDisk: true,
      definingModuleOnDisk: true,
    });
  });

  it('finds both censuses non-empty', () => {
    // Before the pairing, because the pairing passes vacuously on two empty
    // sets: a file walk that stops matching anything reports no unverdicted
    // call and no orphan verdict, which is indistinguishable from a healthy
    // tree. This is the assertion that tells them apart.
    const { callSites, verdicts } = censusOfTree();
    expect({ foundACall: callSites.length > 0, foundAVerdict: verdicts.length > 0 }).toEqual({
      foundACall: true,
      foundAVerdict: true,
    });
  });

  it('pairs every call with one verdict above it, and every verdict with a call', () => {
    // Both directions in one assertion, so a failure names which way it broke
    // rather than reporting two sorted arrays and leaving the reader to diff.
    // The counts ride inside the location string for the same reason: `(2
    // calls, 1 verdict)` says which shape it is without opening this file.
    expect(findings(censusOfTree())).toEqual(CLEAN);
  });
});

/**
 * The rules above, against sources written here.
 *
 * Without these the suite exercises one shape — a plain name, a verdict
 * directly above, one call per anchor — because that is all the repository
 * contains. Measured before they existed: the alias arm, the namespace arm, the
 * one-to-one grouping and the whole orphan direction could each be deleted
 * outright with the suite still green. Following an import alias is the thing
 * the shell censuses of this set are blind to, so that arm going untested made
 * the headline claim the least defended line in the file.
 *
 * Fixture markers are interpolated from `MARKER` for the same reason the
 * constant is assembled: a fixture spelling it out would enter the real census
 * as an orphan verdict the moment the `*.test.ts` exclusion moved.
 */
const FIXTURE = 'src/services/fixture.ts';
const VERDICT = `// ${MARKER}: what this transaction reads and writes.`;

function censusOf(text: string): ReturnType<typeof findings> {
  return findings(takeCensus([{ file: FIXTURE, text }]));
}

describe('the census rules, against sources this repository does not contain', () => {
  it('pairs a plain call with the verdict above it', () => {
    expect(
      censusOf(`async function f(tx: unknown) {\n  ${VERDICT}\n  await ${HELPER}(tx, {});\n}`),
    ).toEqual(CLEAN);
  });

  it('counts a call that never says await', () => {
    expect(
      censusOf(`function f(tx: unknown) {\n  ${VERDICT}\n  void ${HELPER}(tx, {});\n}`),
    ).toEqual(CLEAN);
    expect(censusOf(`function f(tx: unknown) {\n  void ${HELPER}(tx, {});\n}`)).toEqual({
      callSitesNotPairedOneToOne: [`${FIXTURE}:2 (1 call, 0 verdicts)`],
      verdictsWithoutCall: [],
    });
  });

  it('follows a name an import specifier binds to the helper', () => {
    const aliased = [
      `import { ${HELPER} as lockRows } from '@/lib/db-locks';`,
      'async function f(tx: unknown) {',
      `  await lockRows(tx, {});`,
      '}',
    ].join('\n');
    expect(censusOf(aliased)).toEqual({
      callSitesNotPairedOneToOne: [`${FIXTURE}:3 (1 call, 0 verdicts)`],
      verdictsWithoutCall: [],
    });
  });

  it('does not follow an alias bound by an unrelated module', () => {
    const elsewhere = [
      `import { ${HELPER} as lockRows } from '@/lib/somewhere-else';`,
      'async function f(tx: unknown) {',
      `  await lockRows(tx, {});`,
      '}',
    ].join('\n');
    expect(censusOf(elsewhere)).toEqual(CLEAN);
  });

  it('follows a namespace member, by property access and by string key', () => {
    for (const callee of [`ns.${HELPER}`, `ns?.${HELPER}`, `ns['${HELPER}']`]) {
      expect(censusOf(`async function f(tx: unknown) {\n  await ${callee}(tx, {});\n}`)).toEqual({
        callSitesNotPairedOneToOne: [`${FIXTURE}:2 (1 call, 0 verdicts)`],
        verdictsWithoutCall: [],
      });
    }
  });

  it('sees through the wrappers that leave a callee unchanged', () => {
    for (const callee of [`(${HELPER})`, `${HELPER}!`]) {
      expect(censusOf(`async function f(tx: unknown) {\n  await ${callee}(tx, {});\n}`)).toEqual({
        callSitesNotPairedOneToOne: [`${FIXTURE}:2 (1 call, 0 verdicts)`],
        verdictsWithoutCall: [],
      });
    }
  });

  it('does not count the name in a comment or in a string', () => {
    expect(censusOf(`// mentions ${HELPER}(…) in prose\nconst s = '${HELPER}(tx, {})';\n`)).toEqual(
      CLEAN,
    );
  });

  it('pairs across a long trivia run but not across code', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `  // line ${i}`).join('\n');
    expect(
      censusOf(
        `async function f(tx: unknown) {\n  ${VERDICT}\n${filler}\n  await ${HELPER}(tx, {});\n}`,
      ),
    ).toEqual(CLEAN);
  });

  it('anchors a concise-body member on the member, not on the statement', () => {
    // The verdict written where a person would write it — directly above the
    // member holding the call — must pair. This is the shape the repository's
    // only `entries: true` site would take if `around` lost its block body.
    const adjacent = [
      'export const FAMILY = {',
      '  alpha: 1,',
      `  ${VERDICT}`,
      `  withdraw: (tx: unknown) => ${HELPER}(tx, {}),`,
      '};',
    ].join('\n');
    expect(censusOf(adjacent)).toEqual(CLEAN);

    // And a verdict over the whole statement, members away from the call, must
    // not — it answers for the object, which is not a transaction.
    const distant = [
      VERDICT,
      'export const FAMILY = {',
      '  alpha: 1,',
      '  beta: 2,',
      `  withdraw: (tx: unknown) => ${HELPER}(tx, {}),`,
      '};',
    ].join('\n');
    expect(censusOf(distant)).toEqual({
      callSitesNotPairedOneToOne: [`${FIXTURE}:5 (1 call, 0 verdicts)`],
      verdictsWithoutCall: [`${FIXTURE}:1`],
    });
  });

  it('keeps two verdicted siblings apart instead of pooling them', () => {
    const siblings = [
      'export const FAMILY = {',
      `  ${VERDICT}`,
      `  withdraw: (tx: unknown) => ${HELPER}(tx, {}),`,
      `  ${VERDICT}`,
      `  archive: (tx: unknown) => ${HELPER}(tx, {}),`,
      '};',
    ].join('\n');
    expect(censusOf(siblings)).toEqual(CLEAN);
  });

  it('refuses two calls under one verdict', () => {
    const shared = [
      'async function f(tx: unknown) {',
      `  ${VERDICT}`,
      `  const ids = [...(await ${HELPER}(tx, {})), ...(await ${HELPER}(tx, {}))];`,
      '  return ids;',
      '}',
    ].join('\n');
    expect(censusOf(shared)).toEqual({
      callSitesNotPairedOneToOne: [`${FIXTURE}:3 (2 calls, 1 verdict)`],
      verdictsWithoutCall: [],
    });
  });

  it('refuses two verdicts over one call', () => {
    const doubled = [
      'async function f(tx: unknown) {',
      `  ${VERDICT}`,
      `  ${VERDICT}`,
      `  await ${HELPER}(tx, {});`,
      '}',
    ].join('\n');
    expect(censusOf(doubled)).toEqual({
      callSitesNotPairedOneToOne: [`${FIXTURE}:4 (1 call, 2 verdicts)`],
      verdictsWithoutCall: [],
    });
  });

  it('reports a verdict with no call under it, wherever the text sits', () => {
    // A comment referring to somebody else's verdict counts as one, which is
    // why a cross-reference must not spell the marker.
    expect(censusOf(`${VERDICT}\nexport const unrelated = 1;\n`)).toEqual({
      callSitesNotPairedOneToOne: [],
      verdictsWithoutCall: [`${FIXTURE}:1`],
    });
    // And so does one inside a string literal, which is in no comment range.
    expect(censusOf(`export const s = 'see the ${MARKER} above';\n`)).toEqual({
      callSitesNotPairedOneToOne: [],
      verdictsWithoutCall: [`${FIXTURE}:1`],
    });
  });

  it('does not let a verdict on an enclosing construct pair with the call', () => {
    // Documented rather than desired: the anchor is the call's own. A verdict
    // above the `if` is reported twice, which is what tells the author to move
    // it rather than leaving them to guess.
    const enclosing = [
      'async function f(tx: unknown, go: boolean) {',
      `  ${VERDICT}`,
      '  if (go) {',
      `    await ${HELPER}(tx, {});`,
      '  }',
      '}',
    ].join('\n');
    expect(censusOf(enclosing)).toEqual({
      callSitesNotPairedOneToOne: [`${FIXTURE}:4 (1 call, 0 verdicts)`],
      verdictsWithoutCall: [`${FIXTURE}:2`],
    });
  });
});
