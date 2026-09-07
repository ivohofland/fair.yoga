/**
 * Every probe call sits outside every transaction callback.
 *
 * The probes listed in `PROBES` below ask the database which rule or which
 * entry holds a span, after a constraint has already refused a write. Each
 * one's docblock requires its call sites to sit outside every transaction
 * callback — where a caller has a transaction of its own, after that
 * transaction's closing `)`; where the refused transaction lives one layer
 * down, inside a service the caller awaited, with no `)` of its own to sit
 * after. This file is what makes that requirement fail a build rather than
 * fail a reader.
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT. It reads LEXICAL position, and
 * only in the negative direction: no call may sit inside the callback argument
 * of a `$transaction(…)`. It does NOT ask a call site to have a transaction of
 * its own beside it. A caller whose refused transaction lives one layer down —
 * inside the service it awaited, already committed or rolled back by the time
 * the result comes back — is correct, and would be flagged by the stronger rule
 * that "sits after its own transaction's closing `)`" reads as. That shape ships
 * today, and
 * `docs/superpowers/specs/2026-09-06-probe-placement-tether-design.md` §4 is
 * where it is named. Nor does this decide whether the transaction a call probes
 * after is the RIGHT one. That is a judgement about a whole function, and
 * nothing mechanical can make it.
 *
 * THE OTHER HALF OF EACH DOCBLOCK'S RULE IS NOT THIS FILE'S. "Always against
 * `db`, never `tx`" is about the ARGUMENT, and it is held by the type
 * signature: `Prisma.TransactionClient` is `Omit<PrismaClient,
 * ITXClientDenyList>`, which lacks `$transaction` and so is not assignable to a
 * `PrismaClient` parameter. Each probe's own test file pins that with a
 * `@ts-expect-error` on a never-called function, so a parameter widened to
 * accept a transaction client fails `tsc` — `rule-slot-holder.test.ts` and
 * `entry-conflict.test.ts` are where those live. A misplaced call therefore
 * cannot be one passing `tx`; what compiles is a call inside the callback
 * passing the OUTER client, which takes a second pooled connection while the
 * first is still held and reads a snapshot blind to the very transaction it is
 * asked about. That is the one shape left, and it is the shape censused here.
 * The design record above separates those claims and says what holds each.
 *
 * TWO DETECTORS, DELIBERATELY UNLIKE EACH OTHER (the arrangement
 * `db-locks-verdict-census.test.ts` sets out). Both sides here read the syntax
 * tree, so the unlikeness is in the predicates. A call is found by its
 * callee: the probe's own name, a local name an import specifier binds to it
 * from its defining module, or a member of that name read off anything. So a
 * mention of the name in a comment or a string is not a call, and a call that
 * never says `await` still is one. A transaction callback is found by the
 * MEMBER NAME `$transaction` carrying a function-like first argument, whatever
 * receiver it is read off — anchoring on a receiver name would blind the
 * detector to every call site using a different one, and the design record
 * measures the receiver names, inside this census's scope and across the wider
 * tree. A call is inside iff walking up its ancestors reaches a function node
 * that is such a call's first argument, and that walk does not stop at a
 * function boundary: a probe batched into an inline callback is still inside
 * the transaction the outer callback opened. The array form
 * (`$transaction([…])`) has no function argument and therefore contains
 * nothing.
 *
 * NON-VACUITY IS WHERE A CENSUS LIKE THIS DIES, so every guard below carries
 * its own reason beside it rather than a bare boolean. The one this census
 * could not live without is the last: if `$transaction` detection ever stops
 * firing, every call in the repository reports "not inside a transaction" and
 * the headline assertion goes green forever while checking nothing.
 *
 * WHAT IT DOES NOT SEE, so that a call landing there is nobody's failure here.
 * Test files are excluded: a test may place a probe wrongly on purpose to
 * demonstrate what happens, and this rule is about production call sites. The
 * defining modules are NOT excluded — neither calls its own probe, so searching
 * them costs nothing and catches a self-call added later — though
 * `probeOverlappingCandidates`, exported beside `probeConflictingEntry`, is
 * absent from `PROBES` deliberately rather than by oversight: it takes
 * `PrismaClient | Prisma.TransactionClient` because it is MEANT to run on the
 * caller's still-healthy transaction, so a correctly placed call to it inside a
 * transaction callback would be reported here as a defect. A call reaching a
 * probe through a local binding (`const f = ruleSlotHolder; f(db, …)`) is
 * invisible, as are `(0, ruleSlotHolder)(…)` and `(cond ? a : b)(…)`; resolving
 * those needs a full type-checker program this test does not build. An import
 * alias is followed only from a specifier whose last segment is the defining
 * module's own basename, so a probe reached through a re-exporting barrel is
 * not followed either. A callback passed by name (`db.$transaction(handler)`)
 * puts `handler`'s body out of reach for the same reason, and a probe called
 * from a helper that is itself invoked inside a transaction is dynamically
 * inside and lexically outside. Nothing outside `src/` is searched: not
 * `tests/`, not `prisma/seed.ts`, not `scripts/`. Nor is a source `tsconfig`
 * compiles but this walk does not match — `allowJs` is on and `*.mts` is
 * included, so such a file under `src/` would be invisible here.
 *
 * The census also assumes its files parse. `ts.createSourceFile` does not throw
 * and reports no diagnostics here, so a syntax error that swallows a call
 * censuses zero calls quietly. `npm run typecheck` in CI's `checks` job is what
 * holds that, which makes this defence in depth rather than a hole.
 *
 * This file keeps itself out of its own census, and not only by the `*.test.ts`
 * exclusion: every probe name here is data — a string constant, or fixture text
 * inside a template literal — and a string literal is not a call expression, so
 * lifting the exclusion would still census nothing from here.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { PrismaClient } from '@prisma/client';

/** A probe carrying the placement rule, and the module that defines it. */
interface Probe {
  /** Its exported name, which is also the member name a namespace read uses. */
  readonly helper: string;
  /** Repo-relative, and the source of the specifier an alias is followed from. */
  readonly definingModule: string;
}

/**
 * Each probe's name appears here only as data. A string literal is not a call
 * expression, so nothing in this file can enter the call census even with the
 * test-file exclusion lifted.
 *
 * `satisfies` is what keeps each name honest through a rename. Without it a
 * renamed export would simply stop being found, and the census would report no
 * misplaced call — indistinguishable from a healthy tree, and caught only by
 * the non-empty guard below, which would name nothing. With it the compiler
 * refuses this file and lists the module's real exports. That is *Comment
 * Discipline*'s "where membership matters, tether it to the compiler", and the
 * imports are type positions, so they erase and add no runtime dependency.
 */
const RULE_SLOT_HOLDER = 'ruleSlotHolder' satisfies keyof typeof import('./rule-slot-holder');
const PROBE_CONFLICTING_ENTRY =
  'probeConflictingEntry' satisfies keyof typeof import('./entry-conflict');

const PROBES: readonly Probe[] = [
  { helper: RULE_SLOT_HOLDER, definingModule: 'src/lib/rule-slot-holder.ts' },
  { helper: PROBE_CONFLICTING_ENTRY, definingModule: 'src/lib/entry-conflict.ts' },
];

/**
 * The member name a transaction is opened through, tethered the same way and
 * for the same reason. Anchored on the member and never on the receiver: the
 * receiver differs between call sites, and a detector keyed on one of them
 * would silently stop watching every file using another.
 */
const TRANSACTION = '$transaction' satisfies keyof PrismaClient;

const root = process.cwd();

/** Repo-relative paths of every `.ts`/`.tsx` under `src/`, test files included. */
function typeScriptUnderSrc(): string[] {
  return readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .map((p) => `src/${p.split(path.sep).join('/')}`)
    .filter((p) => /\.tsx?$/.test(p))
    .sort();
}

/**
 * Every `.ts`/`.tsx` under `src/`, repo-relative, minus the test files — a test
 * may place a probe inside a transaction on purpose, to show what that does.
 * Directories fall out on the extension filter.
 */
function searchScope(): string[] {
  return typeScriptUnderSrc().filter((p) => !/\.test\.tsx?$/.test(p));
}

/**
 * A SECOND read of `src/`, for the scope-reach guard alone, reaching no line of
 * the walk it checks — not `typeScriptUnderSrc`, not `searchScope`, not their
 * shared walk. It makes its own `readdirSync` call rather than reaching theirs,
 * which means their options object and this one must stay in step; a difference
 * there narrows this side alone, and the guard's second direction is what
 * reports that.
 *
 * The duplication is the whole point. A guard whose two sides come from one
 * function narrows in lockstep with it: a filter added inside that function
 * drops an area from the census AND from the guard's expectation in the same
 * edit, and the comparison stays equal. Only the extension and test-file rules
 * are duplicated here; no exclusion a future edit adds to `searchScope` reaches
 * this, which is exactly what has to make the two disagree.
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

/** `rule-slot-holder` for `src/lib/rule-slot-holder.ts` — what a specifier ends with. */
function specifierTail(probe: Probe): string {
  return path.basename(probe.definingModule, '.ts');
}

/**
 * The local names that reach one probe in one file: its own, plus whatever an
 * import specifier binds it to (`import { ruleSlotHolder as holderOf }`).
 *
 * Only from a module specifier whose last segment is the defining module's
 * basename, so a same-named export from an unrelated module is not swept in.
 * Its own name stays in the set unconditionally, and that is belt and braces
 * rather than redundancy: a call reaching the probe by some route this scan
 * does not model is still caught by its name.
 */
function probeNames(source: ts.SourceFile, probe: Probe): ReadonlySet<string> {
  const names = new Set<string>([probe.helper]);
  const tail = specifierTail(probe);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    if (spec !== tail && !spec.endsWith(`/${tail}`)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.propertyName?.text === probe.helper) names.add(element.name.text);
    }
  }
  return names;
}

/**
 * Wrappers that leave an expression's identity unchanged: `(f)` and `f!`.
 * Used on a callee (`(f)(…)`, `f!(…)`) and, for the same reason, on a
 * `$transaction(…)` call's first argument (`((tx) => {…})`) — a shape check
 * on the unwrapped node, past redundant parentheses it would otherwise fail.
 */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Whether a callee reads a member of the given name, by dot or by string key. */
function readsMember(callee: ts.Expression, member: string): boolean {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === member;
  return (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    callee.argumentExpression.text === member
  );
}

/**
 * The probe a call reaches, or `undefined`. The callee is one of the file's
 * local names for a probe, or a member of that probe's name read off anything —
 * `ns.ruleSlotHolder` or `ns['ruleSlotHolder']` after an `import * as ns`.
 *
 * That last arm is deliberately not qualified by what the receiver is. Reading a
 * member of that name off anything is close enough to a call to be worth
 * checking, and the direction of the error matters: over-including can only
 * demand that a well-named function move out of a transaction, which is loud,
 * while under-including hides a call site, which is the failure this file
 * exists to prevent.
 */
function probeCalled(
  node: ts.Node,
  names: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = unwrapExpression(node.expression);
  return PROBES.find((probe) =>
    ts.isIdentifier(callee)
      ? (names.get(probe.helper)?.has(callee.text) ?? false)
      : readsMember(callee, probe.helper),
  )?.helper;
}

/**
 * The `$transaction(…)` call's first argument, or `undefined` when the call
 * is not one — the array form passes a list rather than a function, and so
 * has no body anything could sit inside. Returned un-unwrapped: the shape
 * check looks past redundant parentheses (`((tx) => {…})`), but the value
 * returned is the actual argument node, so `enclosingTransaction`'s identity
 * comparison against a tree ancestor still matches it.
 */
function transactionCallbackOf(node: ts.Node): ts.Node | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  if (!readsMember(unwrapExpression(node.expression), TRANSACTION)) return undefined;
  const first = node.arguments[0];
  if (first === undefined) return undefined;
  const callback = unwrapExpression(first);
  return ts.isArrowFunction(callback) || ts.isFunctionExpression(callback) ? first : undefined;
}

/**
 * The nearest `$transaction(…)` whose callback lexically contains a node, by
 * walking up its ancestors. The nearest rather than the outermost, so a report
 * names the `)` the author has to move the call past.
 */
function enclosingTransaction(node: ts.Node): ts.CallExpression | undefined {
  let current: ts.Node = node;
  while (!ts.isSourceFile(current)) {
    const parent: ts.Node = current.parent;
    if (ts.isCallExpression(parent) && transactionCallbackOf(parent) === current) return parent;
    current = parent;
  }
  return undefined;
}

interface Site {
  readonly file: string;
  readonly line: number;
}

/** One probe call, with the transaction it sits inside if it sits inside one. */
interface ProbeCall extends Site {
  readonly helper: string;
  readonly insideTransactionAt: number | undefined;
}

interface Census {
  readonly calls: readonly ProbeCall[];
  /** Where every `$transaction(fn, …)` the detector recognised sits. The
   * "recognises transaction callbacks" guard counts these against the real
   * tree; the fixtures compare them as `path:line`. */
  readonly transactionCallbacks: readonly Site[];
}

/** A file to census: its repo-relative path, and its text. */
interface Source {
  readonly file: string;
  readonly text: string;
}

/**
 * Taken over supplied sources rather than off disk, so the placement rule can be
 * exercised against shapes this repository does not currently contain. Under the
 * real tree every misplacement arm below is dead weight, because the tree holds
 * exactly one shape — a call outside every callback. That is what the fixtures
 * at the bottom of this file are for.
 */
function takeCensus(sources: readonly Source[]): Census {
  const calls: ProbeCall[] = [];
  const transactionCallbacks: Site[] = [];

  for (const { file, text } of sources) {
    // The real path is the file name, so `.tsx` parses as TSX rather than as
    // TypeScript reading `<Foo>` as a type assertion. `true` sets parent
    // pointers, which `enclosingTransaction` walks.
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
    const names = new Map<string, ReadonlySet<string>>(
      PROBES.map((probe) => [probe.helper, probeNames(source, probe)]),
    );

    const visit = (node: ts.Node): void => {
      if (transactionCallbackOf(node) !== undefined) {
        transactionCallbacks.push({ file, line: lineOf(node.getStart(source)) });
      }
      const helper = probeCalled(node, names);
      if (helper !== undefined) {
        const enclosing = enclosingTransaction(node);
        calls.push({
          file,
          line: lineOf(node.getStart(source)),
          helper,
          insideTransactionAt:
            enclosing === undefined ? undefined : lineOf(enclosing.getStart(source)),
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  return { calls, transactionCallbacks };
}

/** Sorted the way a reader would open them, so a failure list is stable. */
function byLocation<T extends Site>(sites: readonly T[]): T[] {
  return [...sites].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );
}

/** `path:line`, so every location this file reports is one a reader can open. */
function label(site: Site): string {
  return `${site.file}:${site.line}`;
}

/**
 * The failure list, in the shape the assertions compare. Shared by the real-tree
 * assertion and the fixtures below, so the fixtures pin the reported strings and
 * not merely the internal counts.
 *
 * `path:line` first, because a failure has to be a place a reader can open; the
 * probe's name and the transaction's line ride inside the parentheses so the
 * reader knows which `)` the call has to move past before opening anything.
 */
function findings(census: Census): { callsInsideATransaction: string[] } {
  const inside = census.calls.filter(
    (call): call is ProbeCall & { insideTransactionAt: number } =>
      call.insideTransactionAt !== undefined,
  );
  return {
    callsInsideATransaction: byLocation(inside).map(
      (call) =>
        `${label(call)} (${call.helper}, inside the ${TRANSACTION} callback opened at line ${call.insideTransactionAt})`,
    ),
  };
}

const CLEAN = { callsInsideATransaction: [] };

/**
 * Read once and shared, so the assertions below cannot disagree about what the
 * tree held: taking a census each would let a guard bless a tree the placement
 * assertion never saw, and would pay for the walk more than once.
 */
let treeCensus: Census | undefined;
function censusOfTree(): Census {
  return (treeCensus ??= takeCensus(
    searchScope().map((file) => ({ file, text: readFileSync(path.join(root, file), 'utf8') })),
  ));
}

describe('every probe call sits outside every transaction callback', () => {
  it('runs where the modules that define the probes are', () => {
    // First, so a rename or a wrong working directory is named once here rather
    // than inferred. These paths are what an import specifier is matched
    // against, so a moved module silently stops the census following aliases
    // into files that reach the probe under another name — and reports nothing.
    const missing = PROBES.map((probe) => probe.definingModule).filter(
      (module) => !existsSync(path.join(root, module)),
    );
    expect({ missing }).toEqual({ missing: [] });
  });

  it('reaches every area of src that holds production TypeScript', () => {
    // The non-empty guards below check only that SOMETHING was found, and a
    // probe call site can only be in whichever directories happen to hold one —
    // a fraction of the tree either way. So a filter edit that drops whole
    // directories leaves every guard green while the census stops watching most
    // of the repository.
    //
    // `areasUnderSrc` reads the directory itself rather than calling the walk,
    // so a narrowing that empties an area disagrees with it wherever in the
    // walk it sits — inside the shared `typeScriptUnderSrc` included. The
    // granularity is the area and no finer, as this test's name says: a
    // narrowing leaving an area even one SEARCHED production file passes here.
    // Searched, not merely present: `reached` is what `searchScope` yields, so
    // an area left holding nothing that survives its filter does go red.
    //
    // Both directions, so a failure names which side moved. The second is
    // empty by construction — `areasUnderSrc` applies a strict subset of
    // `searchScope`'s rules to the same tree, so an area the census reaches is
    // always one it requires — and that is what makes it worth asserting: it
    // costs nothing until `areasUnderSrc` itself narrows, and a narrowing
    // there shrinks the very difference the first direction asserts empty.
    const required = areasUnderSrc();
    const reached = new Set(searchScope().map(areaOf));
    expect({
      areasTheCensusMisses: [...required].filter((area) => !reached.has(area)).sort(),
      areasTheGuardMisses: [...reached].filter((area) => !required.has(area)).sort(),
    }).toEqual({ areasTheCensusMisses: [], areasTheGuardMisses: [] });
  });

  it('excludes the test files but not the defining modules, neither vacuously', () => {
    const scope = new Set(searchScope());
    expect({
      testFilesInScope: [...scope].filter((p) => /\.test\.tsx?$/.test(p)),
      // The exclusion would also be satisfied by a tree containing no test
      // file at all, which is a different thing entirely.
      testFilesOnDisk: typeScriptUnderSrc().some((p) => /\.test\.tsx?$/.test(p)),
      // Searched deliberately: a probe called from its own defining module,
      // inside a transaction, is a defect this census should report.
      definingModulesOutOfScope: PROBES.map((p) => p.definingModule).filter((p) => !scope.has(p)),
    }).toEqual({
      testFilesInScope: [],
      testFilesOnDisk: true,
      definingModulesOutOfScope: [],
    });
  });

  it('finds a call to each probe, and not merely a call to one of them', () => {
    // Before the placement assertion, because that assertion passes vacuously
    // on an empty census: a file walk that stops matching anything reports no
    // misplaced call, which is indistinguishable from a healthy tree. Per
    // probe rather than in total, because one probe's name going unfound is
    // exactly what a rename or a moved defining module produces.
    const found = Object.fromEntries(
      PROBES.map((probe) => [
        probe.helper,
        censusOfTree().calls.some((c) => c.helper === probe.helper),
      ]),
    );
    expect(found).toEqual(Object.fromEntries(PROBES.map((probe) => [probe.helper, true])));
  });

  it('recognises transaction callbacks in the tree it just walked', () => {
    // The guard this census cannot live without. Every finding below is a call
    // reported as being INSIDE something; if the detector stops recognising
    // `$transaction` callbacks, every call in the repository is outside one and
    // the placement assertion goes green forever while checking nothing. The
    // fixtures pin the detector's arms one at a time; this pins that it still
    // fires against the real tree, where the arms are actually used.
    expect({
      recognisedACallback: censusOfTree().transactionCallbacks.length > 0,
    }).toEqual({ recognisedACallback: true });
  });

  it('places every probe call outside every transaction callback', () => {
    // The headline, and last, because a green tick here means nothing until the
    // guards above have said the tree was read and the detector fired in it. A
    // failure names the call and the `)` it has to move past.
    expect(findings(censusOfTree())).toEqual(CLEAN);
  });
});

/**
 * The rule above, against sources written here.
 *
 * Without these the suite exercises one shape — a correct call, outside every
 * callback — because that is all the repository contains, and the whole
 * transaction detector could be deleted with the suite still green. Every
 * fixture is a shape a future call site could take, and each asserts the
 * reported strings rather than an internal count, so a report that stops naming
 * a place a reader can open fails here.
 */
const FIXTURE = 'src/services/fixture.ts';

function censusOf(text: string): ReturnType<typeof findings> {
  return findings(takeCensus([{ file: FIXTURE, text }]));
}

/**
 * WHERE the transaction detector fired, as `path:line`, for the fixtures that
 * are about it. A location rather than a count, so a fixture asserting a clean
 * verdict also says which `$transaction` the detector did and did not see —
 * a bare number agrees with a detector that fired on the wrong call.
 */
function callbacksAt(text: string): string[] {
  return byLocation(takeCensus([{ file: FIXTURE, text }]).transactionCallbacks).map(label);
}

/** `src/services/fixture.ts:3 (…, inside the $transaction callback opened at line 2)`. */
function reported(line: number, helper: string, transactionLine: number): string {
  return `${FIXTURE}:${line} (${helper}, inside the ${TRANSACTION} callback opened at line ${transactionLine})`;
}

describe('the placement rule, against sources this repository does not contain', () => {
  it('reports a call inside an arrow callback', () => {
    const source = [
      'async function f(db: unknown) {',
      '  await db.$transaction(async (tx: unknown) => {',
      `    await ${RULE_SLOT_HOLDER}(db, {});`,
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(3, RULE_SLOT_HOLDER, 2)],
    });
  });

  it('reports a call inside a callback wrapped in redundant parentheses', () => {
    // `db.$transaction((async (tx) => {…}))` — the extra `(…)` around the
    // callback makes it a `ParenthesizedExpression` rather than directly an
    // arrow function, so the shape check has to see past it.
    const source = [
      'async function f(db: unknown) {',
      '  await db.$transaction((async (tx: unknown) => {',
      `    await ${RULE_SLOT_HOLDER}(db, {});`,
      '  }));',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(3, RULE_SLOT_HOLDER, 2)],
    });
  });

  it('reports a call inside a function-expression callback', () => {
    const source = [
      'async function f(db: unknown) {',
      '  await db.$transaction(async function run(tx: unknown) {',
      `    await ${PROBE_CONFLICTING_ENTRY}(db, 't', {});`,
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(3, PROBE_CONFLICTING_ENTRY, 2)],
    });
  });

  it('reports a call under a receiver the detector was never told about', () => {
    // Anchored on the member name, so the receiver is free. These names are not
    // a roster of anything — they are spellings the detector must not be able to
    // tell apart, because one keyed on whatever a scan of the tree turned up
    // would report nothing at the call site that adopts the next one.
    for (const receiver of ['db', 'prisma', 'holderClient', 'cancelDb']) {
      const source = [
        `async function f(${receiver}: unknown) {`,
        `  await ${receiver}.$transaction(async (tx: unknown) => {`,
        `    await ${RULE_SLOT_HOLDER}(${receiver}, {});`,
        '  });',
        '}',
      ].join('\n');
      expect(censusOf(source)).toEqual({
        callsInsideATransaction: [reported(3, RULE_SLOT_HOLDER, 2)],
      });
    }
  });

  it('reports a call read through a string key on the receiver', () => {
    const source = [
      'async function f(db: unknown) {',
      `  await db['$transaction'](async (tx: unknown) => {`,
      `    await ${RULE_SLOT_HOLDER}(db, {});`,
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(3, RULE_SLOT_HOLDER, 2)],
    });
  });

  it('reports a call nested blocks deep inside the callback', () => {
    const source = [
      'async function f(db: unknown, go: boolean) {',
      '  await db.$transaction(async (tx: unknown) => {',
      '    if (go) {',
      '      for (const candidate of []) {',
      `        await ${RULE_SLOT_HOLDER}(db, { candidate });`,
      '      }',
      '    }',
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(5, RULE_SLOT_HOLDER, 2)],
    });
  });

  it('reports a call in a catch that is itself inside the callback', () => {
    // The shape most likely to be written by mistake: the `catch` is where a
    // correct call site does its probing, and moving it one level in is the
    // whole defect. The transaction it catches for is still open here.
    const source = [
      'async function f(db: unknown) {',
      '  await db.$transaction(async (tx: unknown) => {',
      '    try {',
      '      await tx.scheduleRule.create({});',
      '    } catch {',
      `      await ${RULE_SLOT_HOLDER}(db, {});`,
      '    }',
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(6, RULE_SLOT_HOLDER, 2)],
    });
  });

  it('reports a call inside a nested function within the callback', () => {
    // The ancestor walk crosses function boundaries on purpose. A probe batched
    // into an inline `.map(async …)` runs on the outer client while the
    // callback's transaction is still open, exactly as an unbatched one would,
    // so a walk that stopped at the nearest arrow would report this clean — and
    // this is the shape a batching refactor of the entry creates produces.
    const source = [
      'async function f(prisma: unknown, items: unknown[]) {',
      '  await prisma.$transaction(async (tx: unknown) => {',
      '    await Promise.all(items.map(async (item: unknown) => {',
      `      await ${PROBE_CONFLICTING_ENTRY}(prisma, 't', { item });`,
      '    }));',
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(4, PROBE_CONFLICTING_ENTRY, 2)],
    });
  });

  it('reports a call reached through an import alias inside the callback', () => {
    const source = [
      `import { ${RULE_SLOT_HOLDER} as holderOf } from '@/lib/rule-slot-holder';`,
      'async function f(db: unknown) {',
      '  await db.$transaction(async (tx: unknown) => {',
      '    await holderOf(db, {});',
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(4, RULE_SLOT_HOLDER, 3)],
    });
  });

  it('does not follow an alias bound by an unrelated module', () => {
    const source = [
      `import { ${RULE_SLOT_HOLDER} as holderOf } from '@/lib/somewhere-else';`,
      'async function f(db: unknown) {',
      '  await db.$transaction(async (tx: unknown) => {',
      '    await holderOf(db, {});',
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual(CLEAN);
    expect(callbacksAt(source)).toEqual([`${FIXTURE}:3`]);
  });

  it('reports a call reached as a namespace member, by property access, optional chaining or string key', () => {
    for (const callee of [
      `probes.${PROBE_CONFLICTING_ENTRY}`,
      `probes?.${PROBE_CONFLICTING_ENTRY}`,
      `probes['${PROBE_CONFLICTING_ENTRY}']`,
    ]) {
      const source = [
        `import * as probes from '@/lib/entry-conflict';`,
        'async function f(prisma: unknown) {',
        '  await prisma.$transaction(async (tx: unknown) => {',
        `    await ${callee}(prisma, 't', {});`,
        '  });',
        '}',
      ].join('\n');
      expect(censusOf(source)).toEqual({
        callsInsideATransaction: [reported(4, PROBE_CONFLICTING_ENTRY, 3)],
      });
    }
  });

  it('sees through the wrappers that leave a callee unchanged', () => {
    for (const callee of [`(${RULE_SLOT_HOLDER})`, `${RULE_SLOT_HOLDER}!`]) {
      const source = [
        'async function f(db: unknown) {',
        '  await db.$transaction(async (tx: unknown) => {',
        `    await ${callee}(db, {});`,
        '  });',
        '}',
      ].join('\n');
      expect(censusOf(source)).toEqual({
        callsInsideATransaction: [reported(3, RULE_SLOT_HOLDER, 2)],
      });
    }
  });

  it('reports only the call inside, leaving its well-placed sibling alone', () => {
    const source = [
      'async function f(db: unknown) {',
      '  await db.$transaction(async (tx: unknown) => {',
      `    await ${RULE_SLOT_HOLDER}(db, {});`,
      '  });',
      `  await ${PROBE_CONFLICTING_ENTRY}(db, 't', {});`,
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(3, RULE_SLOT_HOLDER, 2)],
    });
  });

  it('accepts a call after the callback closes', () => {
    // The well-placed shape the whole rule is about: the probe issued once the
    // callback has returned and the transaction is closed. Written out here so
    // the clean verdict is pinned by a source this file controls, rather than
    // by the tree agreeing with itself.
    const source = [
      'async function f(db: unknown) {',
      '  const outcome = await db.$transaction(async (tx: unknown) => {',
      '    return tx.scheduleRule.create({});',
      '  });',
      `  if (!outcome) await ${RULE_SLOT_HOLDER}(db, {});`,
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual(CLEAN);
    expect(callbacksAt(source)).toEqual([`${FIXTURE}:2`]);
  });

  it('accepts a call before the transaction opens', () => {
    // Documented rather than desired: the rule is only that a call is not
    // INSIDE a callback. A probe issued before the transaction opens is a
    // different question — whether it is useful — and not one lexical position
    // can answer.
    const source = [
      'async function f(db: unknown) {',
      `  await ${RULE_SLOT_HOLDER}(db, {});`,
      '  await db.$transaction(async (tx: unknown) => tx.scheduleRule.create({}));',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual(CLEAN);
    // The concise-body callback IS recognised, so the clean verdict is about
    // where the call sits and not about the detector having gone quiet.
    expect(callbacksAt(source)).toEqual([`${FIXTURE}:3`]);
  });

  it('accepts a call in a file holding no transaction at all', () => {
    // A call site whose refused transaction lives one layer down, inside the
    // service it awaited. It ships, so the census asserts only the negative:
    // demanding a lexical transaction beside every probe would flag it.
    const source = [
      'async function f(prisma: unknown, result: { reason: string }) {',
      `  if (result.reason === 'slot_conflict') {`,
      `    await ${PROBE_CONFLICTING_ENTRY}(prisma, 't', {});`,
      '  }',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual(CLEAN);
    expect(callbacksAt(source)).toEqual([]);
  });

  it('finds nothing to be inside in the array form of a transaction', () => {
    // `$transaction([…])` runs statements, not a callback, so there is no body
    // a call could sit in. Where the detector fired is asserted beside the
    // verdict because a detector that recognised nothing at all would also
    // report this clean.
    const source = [
      'async function f(db: unknown) {',
      '  await db.$transaction([db.a.create({}), db.b.create({})]);',
      `  await ${RULE_SLOT_HOLDER}(db, {});`,
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual(CLEAN);
    expect(callbacksAt(source)).toEqual([]);
  });

  it('reads the first argument only, so a function later in the list cannot enclose', () => {
    // The interactive form is `$transaction(callback, options)`: the callback is
    // the FIRST argument, and a function anywhere else in the list is not a
    // transaction body. A detector taking whichever argument happens to be
    // function-shaped would report a call that never runs in the transaction.
    const trailing = [
      'async function f(db: unknown) {',
      '  await db.$transaction([], async (tx: unknown) => {',
      `    await ${RULE_SLOT_HOLDER}(db, {});`,
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(trailing)).toEqual(CLEAN);
    expect(callbacksAt(trailing)).toEqual([]);

    // And a function reached through an options object, which is not an
    // argument of the call at all.
    const nested = [
      'async function f(db: unknown) {',
      `  await db.$transaction([], { onEvent: () => ${RULE_SLOT_HOLDER}(db, {}) });`,
      '}',
    ].join('\n');
    expect(censusOf(nested)).toEqual(CLEAN);
    expect(callbacksAt(nested)).toEqual([]);
  });

  it('reports a call inside the interactive form that carries options', () => {
    // `$transaction(async (tx) => {…}, { timeout })`. A second argument must not
    // stop the first from being the callback — this is the shape a call site
    // reaches for the moment it needs a longer timeout.
    const source = [
      'async function f(db: unknown) {',
      '  await db.$transaction(async (tx: unknown) => {',
      `    await ${RULE_SLOT_HOLDER}(db, {});`,
      '    return tx;',
      '  }, { timeout: 10_000 });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(3, RULE_SLOT_HOLDER, 2)],
    });
    expect(callbacksAt(source)).toEqual([`${FIXTURE}:2`]);
  });

  it('does not reach a callback passed by name, and says so here', () => {
    // A blind spot, pinned so it is a known one. Resolving `handler` to its
    // declaration needs a full type-checker program this test does not build,
    // so the call inside it is lexically outside every callback and reported
    // clean. Nothing recognises a callback here either, since the first
    // argument is an identifier.
    const source = [
      'async function handler(tx: unknown, db: unknown) {',
      `  await ${RULE_SLOT_HOLDER}(db, {});`,
      '}',
      'async function f(db: unknown) {',
      '  await db.$transaction(handler);',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual(CLEAN);
    expect(callbacksAt(source)).toEqual([]);
  });

  it('does not count the name in a comment or in a string', () => {
    const source = [
      'async function f(db: unknown) {',
      '  await db.$transaction(async (tx: unknown) => {',
      `    // ${RULE_SLOT_HOLDER}(db, {}) would be wrong here`,
      `    const s = '${PROBE_CONFLICTING_ENTRY}(db, t, {})';`,
      '    return s;',
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual(CLEAN);
    expect(callbacksAt(source)).toEqual([`${FIXTURE}:2`]);
  });

  it('counts a call inside a callback that never says await', () => {
    const source = [
      'function f(db: unknown) {',
      '  return db.$transaction((tx: unknown) => {',
      `    void ${RULE_SLOT_HOLDER}(db, {});`,
      '    return tx;',
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(3, RULE_SLOT_HOLDER, 2)],
    });
  });

  it('names the nearest transaction when callbacks are nested', () => {
    // The `)` the author has to move the call past is the inner one; naming the
    // outer would send them to the wrong line.
    const source = [
      'async function f(db: unknown, other: unknown) {',
      '  await db.$transaction(async (tx: unknown) => {',
      '    await other.$transaction(async (inner: unknown) => {',
      `      await ${RULE_SLOT_HOLDER}(db, {});`,
      '    });',
      '  });',
      '}',
    ].join('\n');
    expect(censusOf(source)).toEqual({
      callsInsideATransaction: [reported(4, RULE_SLOT_HOLDER, 3)],
    });
    expect(callbacksAt(source)).toEqual([`${FIXTURE}:2`, `${FIXTURE}:3`]);
  });

  it('orders a report across files by path before line', () => {
    // The only fixture holding more than one file, and the only thing that
    // exercises the cross-file arm of the sort. Every other fixture is a single
    // path, and the real tree reports nothing, so without this the arm could be
    // replaced by identity and the suite would stay green — leaving a
    // multi-file failure list in whatever order the walk reached the files.
    // Passed later-first, so a report in path order is the sort's doing.
    const inside = (helper: string): string =>
      [
        'async function f(db: unknown) {',
        '  await db.$transaction(async (tx: unknown) => {',
        `    await ${helper}(db, {});`,
        '  });',
        '}',
      ].join('\n');
    const later = 'src/services/z-later.ts';
    const earlier = 'src/app/api/a-earlier.ts';
    const census = takeCensus([
      { file: later, text: inside(RULE_SLOT_HOLDER) },
      { file: earlier, text: inside(PROBE_CONFLICTING_ENTRY) },
    ]);
    expect(findings(census)).toEqual({
      callsInsideATransaction: [
        `${earlier}:3 (${PROBE_CONFLICTING_ENTRY}, inside the ${TRANSACTION} callback opened at line 2)`,
        `${later}:3 (${RULE_SLOT_HOLDER}, inside the ${TRANSACTION} callback opened at line 2)`,
      ],
    });
  });
});
