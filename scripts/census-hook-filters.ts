// scripts/census-hook-filters.ts
//
// Lists afterAll/afterEach writes whose filter can be undefined (#783): bulk
// writes in the hook's body and in same-file functions it calls, one level
// deep, plus calls handing such a binding to a helper it does not follow.
// Its reach and known misses are in docs/test-database.md (section 6).
// A report, not a gate: it always exits 0. The runtime guard is the gate.
// Run: pnpm run census:hook-filters
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import { censusHookFilters, type HookFilterFinding } from '../src/lib/hook-filter-census';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const files = execFileSync('git', ['ls-files', '--', '*.test.ts', '*.test.tsx', '*.spec.ts', 'tests/**/*.ts'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter((line) => line !== '')
  .map((rel) => path.resolve(repoRoot, rel));

const configPath = path.join(repoRoot, 'tsconfig.json');
const config = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
if (config.error !== undefined) {
  console.error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot, undefined, configPath);
const program = ts.createProgram(files, { ...parsed.options, incremental: false, noEmit: true });

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
