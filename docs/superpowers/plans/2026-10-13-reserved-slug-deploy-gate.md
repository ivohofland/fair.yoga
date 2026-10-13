# Reserved-slug deploy gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deploy refuses to go live when a teacher already holds a name in `RESERVED_SLUGS`. The route test also covers nested route groups and `public/`.

**Architecture:** The list moves to a leaf module with no imports, so the migrate image can load it without `tsconfig` paths. A framework-agnostic service finds the holders, and a thin CLI runs it after `prisma migrate deploy` in the migrate image's CMD. `deploy.sh` already aborts on a non-zero migrate run (#857).

**Tech Stack:** TypeScript, Prisma, vitest, tsx, Docker multi-stage, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-13-reserved-slug-deploy-gate-design.md`

## Global Constraints

- One list: `RESERVED_SLUGS` exists only in `src/lib/reserved-slugs.ts`. `schemas.ts` imports it.
- Code that runs in the migrate image uses **relative imports only** (no `@/`), because that image has no `tsconfig.json`.
- Comment discipline (CLAUDE.md): no counts or rosters in comments, and comments annotate their own code.
- Never kill or restart the dev server on :3000. In this worktree, `pnpm run worktree:up` provides the integration app.
- Stage exact paths, never `git add -A` or `git add .`. Quote paths containing parentheses.
- Node 24 is needed: prefix commands with `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.

## Review Focus

1. **A missing `COPY` in the migrate stage.** The script must load in the image, or every deploy is refused with module-not-found. Task 2's CI step and its local docker proof pin this.
2. **The script swallowing a DB error and exiting 0.** It must fail closed. Task 2's CLI uses an explicit `.catch` → exit 1.
3. **A nested group `(a)/(b)/x` being dropped by the route walk.** Task 1's mutation proof covers it.
4. **An extensionless file in `public/` passing unnoticed.** Task 1's mutation proof covers it.
5. **No holders → exit 0, with a line saying so.** A silent pass would be indistinguishable from the check not running. Task 2's local docker proof covers it.

---

### Task 1: Leaf module and the route test's two gaps

**Files:**
- Create: `src/lib/reserved-slugs.ts`
- Modify: `src/lib/schemas.ts` (remove the local `RESERVED_SLUGS` and its comment, and import it)
- Modify: `src/lib/schemas.test.ts` (the test *reserves every static top-level route segment*, around line 716)

**Interfaces:**
- Produces: `export const RESERVED_SLUGS: ReadonlySet<string>` from `src/lib/reserved-slugs.ts`. The file has no imports.

- [ ] **Step 1: Move the list.** Create `src/lib/reserved-slugs.ts` with the same `new Set([...])` contents, typed `ReadonlySet<string>` and exported. Move the existing comment above it, and edit the comment so it states:
  - a static route segment beats `(public)/[slug]`;
  - `schemas.test.ts` holds every static top-level route segment, and every top-level `public/` entry name, against this set;
  - names are reserved ahead of any route because a name a teacher holds can't later become a page without hiding theirs, and a deploy refuses while a teacher holds one (`scripts/check-reserved-slugs.ts`);
  - the one line: a `next.config` rewrite, a path the proxy routes, or an nginx `location` can claim a name too, and nothing tests those, so reserve the name here when one does.

  In `schemas.ts`, add `import { RESERVED_SLUGS } from '@/lib/reserved-slugs';` and delete the local declaration and its comment. `pageSlugField` is unchanged.

- [ ] **Step 2: Replace the route test** with a recursive group walk plus `public/`:

```ts
  // Every static first segment of the app, inside route groups at any depth,
  // beats `(public)/[slug]`, and so does every top-level entry of `public/`; a
  // slug equal to one would never reach its teacher's page.
  it('reserves every static top-level route segment and public/ name', () => {
    const app = path.resolve(__dirname, '../app');
    const entries = (dir: string) => readdirSync(dir, { withFileTypes: true });
    const segments = (dir: string): string[] =>
      entries(dir)
        .filter((d) => d.isDirectory())
        .flatMap((d) => (/^\(.+\)$/.test(d.name) ? segments(path.join(dir, d.name)) : [d.name]));
    const statics = segments(app).filter((name) => !name.startsWith('['));
    const publicNames = entries(path.resolve(__dirname, '../../public')).map((d) => d.name);
    expect(statics.length).toBeGreaterThan(0);
    expect(publicNames.length).toBeGreaterThan(0);
    expect([...statics, ...publicNames].filter((name) => pageSlugField.safeParse(name).success)).toEqual([]);
  });
```

  (A name that still begins with `(` after the walk, such as an intercepting route `(.)x`, fails `pageSlugField`'s regex, so it needs no filter.)

- [ ] **Step 3: Run it.** `pnpm exec vitest run --project unit src/lib/schemas.test.ts`. Expect PASS.

- [ ] **Step 4: Prove each gap is now guarded, one mutation at a time.** Record the exact failure text of each, then restore and re-run green:
  1. `mkdir -p "src/app/(public)/(probe)/zz-probe" && touch "src/app/(public)/(probe)/zz-probe/page.tsx"`. Expect a failure naming `zz-probe`. Also run the *original* test body, via `git stash` of the test file only, to show it passed with this mutation in place. Then remove the directory.
  2. `touch public/zz-probe`. Expect a failure naming `zz-probe`. Remove the file.
  3. Shrink `RESERVED_SLUGS` by deleting `'settings'`. Expect a failure naming `settings`. Restore it.

- [ ] **Step 5: Typecheck and commit.** `pnpm exec tsc --noEmit`, then:

```bash
git add src/lib/reserved-slugs.ts src/lib/schemas.ts src/lib/schemas.test.ts
git commit -m "refactor: RESERVED_SLUGS in a leaf module; route test walks nested groups and public/ (#855)"
```

### Task 2: The deploy gate

**Files:**
- Create: `src/services/reserved-slug-holders.ts`, `src/services/reserved-slug-holders.test.ts`, `scripts/check-reserved-slugs.ts`
- Modify: `Dockerfile` (`migrate` stage and the header comment if needed), `.github/workflows/ci.yml` (`docker-build` job), `DEPLOYMENT.md` §6, `package.json` (script entry)

**Interfaces:**
- Consumes: `RESERVED_SLUGS` from `src/lib/reserved-slugs.ts` (Task 1).
- Produces: `findReservedSlugHolders(db: PrismaClient, reserved: Iterable<string>): Promise<{ teacherId: string; pageSlug: string }[]>`, ordered by `pageSlug`.

- [ ] **Step 1: Failing test** `src/services/reserved-slug-holders.test.ts`. It runs in the `unit` project, which has a DB, and follows `admin-grants.test.ts`. Pass the function names that are *not* in `RESERVED_SLUGS`, so the test can't collide with real reserved rows or other files:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../../tests/helpers';
import { findReservedSlugHolders } from './reserved-slug-holders';

const db = new PrismaClient();
const suffix = uniqueSuffix();
const teacherIds: string[] = [];

async function teacherWithSlug(pageSlug: string): Promise<string> {
  const email = `reserved-slug-${pageSlug}@test.local`;
  const t = await db.teacher.create({
    data: { firstName: 'Slug', lastName: 'Holder', email, bio: '', pageSlug, account: { create: { email } } },
    select: { id: true },
  });
  teacherIds.push(t.id);
  return t.id;
}

afterAll(async () => {
  // delete teachers then their accounts, mirroring admin-grants.test.ts cleanup
  await db.$disconnect();
});

describe('findReservedSlugHolders', () => {
  it('names each teacher holding a reserved name, ordered by slug, and no one else', async () => {
    const b = await teacherWithSlug(`zz-b-${suffix}`);
    const a = await teacherWithSlug(`zz-a-${suffix}`);
    await teacherWithSlug(`zz-free-${suffix}`);
    const holders = await findReservedSlugHolders(db, [`zz-b-${suffix}`, `zz-a-${suffix}`, `zz-unheld-${suffix}`]);
    expect(holders).toEqual([
      { teacherId: a, pageSlug: `zz-a-${suffix}` },
      { teacherId: b, pageSlug: `zz-b-${suffix}` },
    ]);
  });

  it('answers empty for an empty list', async () => {
    expect(await findReservedSlugHolders(db, [])).toEqual([]);
  });
});
```

  The implementer completes the cleanup to match the actual cascade in `prisma/schema.prisma` (Teacher → Account). Check `uniqueSuffix()`'s format for slug-safety (lowercase, alphanumeric, hyphens) and lowercase it if needed. Run it and expect FAIL (module not found).

- [ ] **Step 2: Service.** Relative imports only:

```ts
import type { PrismaClient } from '@prisma/client';

/** A teacher whose page slug is a reserved name. */
export interface ReservedSlugHolder {
  teacherId: string;
  pageSlug: string;
}

/**
 * Every teacher holding one of `reserved` as their page slug, ordered by slug.
 * Imported by the deploy check in the migrate image, so it imports nothing
 * through the `@/` alias.
 */
export async function findReservedSlugHolders(
  db: PrismaClient,
  reserved: Iterable<string>,
): Promise<ReservedSlugHolder[]> {
  const rows = await db.teacher.findMany({
    where: { pageSlug: { in: [...reserved] } },
    select: { id: true, pageSlug: true },
    orderBy: { pageSlug: 'asc' },
  });
  return rows.map((r) => ({ teacherId: r.id, pageSlug: r.pageSlug }));
}
```

  Run the test and expect PASS.

- [ ] **Step 3: CLI** `scripts/check-reserved-slugs.ts`:

```ts
/**
 * Deploy gate (#855): refuses while a teacher holds a reserved page slug.
 * The migrate image runs it after `prisma migrate deploy`; a non-zero exit
 * stops the deploy before any container is replaced (DEPLOYMENT.md §6).
 *   pnpm check:reserved-slugs
 */
import { PrismaClient } from '@prisma/client';
import { RESERVED_SLUGS } from '../src/lib/reserved-slugs';
import { findReservedSlugHolders } from '../src/services/reserved-slug-holders';

async function main(): Promise<number> {
  const db = new PrismaClient();
  try {
    const holders = await findReservedSlugHolders(db, RESERVED_SLUGS);
    if (holders.length === 0) {
      console.log('reserved-slug check: no teacher holds a reserved page slug');
      return 0;
    }
    for (const h of holders) console.error(`reserved-slug check: "${h.pageSlug}" is held by teacher ${h.teacherId}`);
    console.error('reserved-slug check: refusing the deploy; see DEPLOYMENT.md §6, A reserved page slug a teacher holds');
    return 1;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('reserved-slug check: failed to run; refusing the deploy', err);
    process.exit(1);
  },
);
```

  Add `"check:reserved-slugs": "tsx scripts/check-reserved-slugs.ts"` to `package.json` scripts, beside the `admin:*` entries. Smoke-test it against the worktree's dev DB: `pnpm check:reserved-slugs` exits 0 and prints the no-holder line.

- [ ] **Step 4: Dockerfile migrate stage.** Copy `src/lib/reserved-slugs.ts`, `src/services/reserved-slug-holders.ts` and `scripts/check-reserved-slugs.ts`, with a one-line comment like the admin-grant one: *The deploy gate run after migrations (DEPLOYMENT.md §6).* Then:

```dockerfile
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm exec tsx scripts/check-reserved-slugs.ts"]
```

  Commands that override CMD (§8's admin CLI, `migrate resolve`) are unaffected.

- [ ] **Step 5: Prove it in the real image, locally.** Record outputs.
  - `docker build --target migrate -t fy-migrate-855 .`
  - The worktree's dev DB URL is in `.env`. From the container, the host is `host.docker.internal`.
  - With no holder: `docker run --rm -e DATABASE_URL=<url with host.docker.internal> fy-migrate-855`. Expect migrate output, then the no-holder line, and exit 0.
  - With a holder: in the worktree dev DB, set one teacher's `pageSlug` to `about` (psql in the `fairyoga-db-1` container, against the worktree's dev database only). Re-run and expect the holder line, the refusal line, and exit 1. Restore the slug and re-run to exit 0.
  - The CI probe, locally: `docker run --rm --network none -e DATABASE_URL='postgresql://u:p@203.0.113.1:5432/none?connect_timeout=3' fy-migrate-855 pnpm exec tsx scripts/check-reserved-slugs.ts`. Expect `P1001` in the output and a non-zero exit. Then break it: comment out the `COPY src/services/reserved-slug-holders.ts` line, rebuild, re-run, and expect no P1001 (module not found). Restore.

- [ ] **Step 6: CI step** in `docker-build`, after *Prisma schema engine loads in the migration image*, written in the same style:

```yaml
      # The deploy gate (#855) runs from this image after the migrations; a
      # file it imports but the stage does not COPY would refuse every deploy.
      # Reaching P1001 means every import resolved.
      - name: Reserved-slug check loads in the migration image
        run: |
          OUT="$(docker run --rm --network none -e DATABASE_URL='postgresql://u:p@203.0.113.1:5432/none?connect_timeout=3' fairyoga-migrate pnpm exec tsx scripts/check-reserved-slugs.ts 2>&1)" || true
          echo "$OUT"
          grep -q 'P1001' <<< "$OUT" || { echo "::error::the reserved-slug check did not reach the database - it failed to load in the migration image"; exit 1; }
```

- [ ] **Step 7: DEPLOYMENT.md §6.** Add a subsection, `### A reserved page slug a teacher holds`, after *A failed migration*. Its content:
  - The migrate step runs `scripts/check-reserved-slugs.ts` after the migrations, which refuses while any teacher's page slug is in `RESERVED_SLUGS`. It prints each slug and teacher id, and the deploy stops with no container replaced. The migrations it applied stay applied, which the rule earlier in §6 already makes safe.
  - Why it matters: a new route hides that teacher's page, and a new reservation makes their profile saves fail.
  - The fix is a human decision. Either talk to the teacher and move them to a new slug (an `UPDATE "Teacher" SET "pageSlug" = … WHERE id = …` via `psql`), or drop the name from the release and rename the route. Then deploy the same commit again.
  - Every `up` built from the refused commit's images runs the check too, and like a failed migration it leaves `app` replaced by a container that never starts. So run no `up` until the slug is resolved, or rebuild from the old commit.
  - Keep the paragraph style of the neighbouring subsections: short paragraphs, no counts.

  Also add the sentence "then checks that no teacher holds a reserved page slug" where §6's opening paragraph describes the migrate step.

- [ ] **Step 8: Verify and commit.** Run `pnpm exec tsc --noEmit && pnpm run lint`, and the service test. Then:

```bash
git add src/services/reserved-slug-holders.ts src/services/reserved-slug-holders.test.ts scripts/check-reserved-slugs.ts Dockerfile .github/workflows/ci.yml DEPLOYMENT.md package.json
git commit -m "feat: refuse a deploy while a teacher holds a reserved page slug (#855)"
```

## Task order

Task 1 must land before Task 2: the CLI imports `src/lib/reserved-slugs.ts`.
