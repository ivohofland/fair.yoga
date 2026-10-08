/**
 * Every exported write handler under `src/app/api` is
 * `export const X = withErrorHandler(…)`.
 *
 * The cross-origin refusal lives inside `withErrorHandler`
 * (`src/lib/api-utils.ts`), so a write handler exported any other way — a
 * plain `export async function POST`, a `const` bound to something else, an
 * `export { handler as POST }` — takes cross-site writes without a word. This
 * reads each `route.ts`'s syntax tree and names every such export.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const API = path.resolve(__dirname, '..', 'app', 'api');
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WRAPPER = 'withErrorHandler';

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isWrapped(initializer: ts.Expression | undefined): boolean {
  return (
    initializer !== undefined &&
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === WRAPPER
  );
}

interface Census {
  /** `file: METHOD` for every exported write handler seen, wrapped or not. */
  seen: string[];
  /** `file: METHOD (how)` for every one not exported as `withErrorHandler(…)`. */
  unwrapped: string[];
}

function census(): Census {
  const seen: string[] = [];
  const unwrapped: string[] = [];
  for (const file of routeFiles(API)) {
    const rel = path.relative(path.resolve(__dirname, '..', '..'), file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
        const name = statement.name?.text;
        if (name !== undefined && WRITE_METHODS.has(name)) {
          seen.push(`${rel}: ${name}`);
          unwrapped.push(`${rel}: ${name} (exported as a function)`);
        }
      } else if (ts.isVariableStatement(statement) && isExported(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !WRITE_METHODS.has(declaration.name.text)) continue;
          seen.push(`${rel}: ${declaration.name.text}`);
          if (!isWrapped(declaration.initializer)) {
            unwrapped.push(`${rel}: ${declaration.name.text} (not bound to ${WRAPPER}(…))`);
          }
        }
      } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!WRITE_METHODS.has(element.name.text)) continue;
          seen.push(`${rel}: ${element.name.text}`);
          unwrapped.push(`${rel}: ${element.name.text} (re-exported by name)`);
        }
      }
    }
  }
  return { seen, unwrapped };
}

describe('write handler wrap census', () => {
  it('reads route files and finds write handlers in them', () => {
    // Non-vacuity: a walk that stopped reaching the routes, or a predicate
    // that stopped recognising an export, would pass the next test silently.
    expect(census().seen).toContain('src/app/api/classes/route.ts: POST');
  });

  it('every exported WRITE_METHODS handler is withErrorHandler(…)', () => {
    expect(census().unwrapped).toEqual([]);
  });
});
