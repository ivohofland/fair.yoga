// scripts/census-hook-filters.ts
//
// Lists afterAll/afterEach writes whose filter can be undefined (#783): bulk
// writes in the hook's body and in same-file functions it calls, one level
// deep, plus calls handing such a binding to a helper it does not follow.
// Its reach and known misses are in docs/test-database.md (section 6).
// A report, not a gate: it exits 0 whatever it finds. The runtime guard is the gate.
// It exits 1 when it could not read what it meant to: no files collected, a
// collected file missing from the program, or a file that does not parse.
// Run: pnpm run census:hook-filters
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import { censusHookFilters, type HookFilterFinding } from '../src/lib/hook-filter-census';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function fail(message: string): never {
  console.error(`census-hook-filters: ${message}`);
  process.exit(1);
}

const files = execFileSync(
  'git',
  ['ls-files', '--', '*.test.ts', '*.test.tsx', '*.spec.ts', 'tests/*.ts', 'tests/**/*.ts'],
  { cwd: repoRoot, encoding: 'utf8' },
)
  .split('\n')
  .filter((line) => line !== '')
  .map((rel) => path.resolve(repoRoot, rel));
if (files.length === 0) fail('git ls-files collected no test files; nothing was scanned.');

const configPath = path.join(repoRoot, 'tsconfig.json');
const config = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
if (config.error !== undefined) {
  console.error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot, undefined, configPath);
const program = ts.createProgram(files, { ...parsed.options, incremental: false, noEmit: true });

const missing = files.filter((file) => program.getSourceFile(file) === undefined);
if (missing.length > 0) {
  fail(`not in the program, so not scanned:\n${missing.map((f) => `  ${path.relative(repoRoot, f)}`).join('\n')}`);
}
const unparsed = files.flatMap((file) => {
  const source = program.getSourceFile(file);
  const diagnostics = source === undefined ? [] : program.getSyntacticDiagnostics(source);
  return diagnostics.map(
    (d) => `  ${path.relative(repoRoot, file)}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
  );
});
if (unparsed.length > 0) fail(`syntax errors, so the census would misread these files:\n${unparsed.join('\n')}`);

const findings = censusHookFilters(program, files, repoRoot).sort(
  (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
);

const label = (f: HookFilterFinding): string => (f.guarded ? 'guarded  ' : 'UNGUARDED');
for (const f of findings) {
  console.log(`${label(f)}  ${f.kind.padEnd(8)}  ${f.client.padEnd(4)}  ${f.file}:${f.line}  ${f.call}  [${f.bindings.join(', ')}]`);
}

const count = (guarded: boolean, kind: HookFilterFinding['kind']): number =>
  findings.filter((f) => f.guarded === guarded && f.kind === kind).length;
const appRows = findings.filter((f) => f.client === 'app').length;
const fileCount = new Set(findings.map((f) => f.file)).size;

console.log('');
console.log(`Totals over ${files.length} files scanned; ${findings.length} rows in ${fileCount} files:`);
console.log(`  UNGUARDED direct    ${count(false, 'direct')}`);
console.log(`  UNGUARDED indirect  ${count(false, 'indirect')}`);
console.log(`  guarded   direct    ${count(true, 'direct')}`);
console.log(`  guarded   indirect  ${count(true, 'indirect')}`);
console.log(`  of which client=app (outside the guard's reach)  ${appRows}`);
