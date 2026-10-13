# Refuse a deploy that would reserve a page slug a teacher holds (#855)

## Problem

`RESERVED_SLUGS` lists the names a teacher can't claim as `fair.yoga/<pageSlug>`.
When a release adds a name, either as a new top-level route or as a plain
reservation (#854), a teacher who already holds it either loses their public
page behind the new route or gets their profile saves refused. The code side
is already guarded by the route test, but nothing checks the production data.

## What was measured

- **The "verify first" question is settled by #857** (closed 2026-10-13).
  `deploy/deploy.sh` runs `docker compose run --rm migrate` as its own step
  before `up -d`, and a non-zero exit stops the run with "migrate failed; no
  container was replaced". So a check that exits non-zero inside the migrate
  image refuses the deploy, and the old app keeps serving.
- **The migrate image cannot import `src/lib/schemas.ts`.** The stage is
  `FROM deps` plus `prisma/` and two copied files. It has no `tsconfig.json`,
  so `@/` aliases don't resolve, and `schemas.ts` imports eight `@/lib/*`
  modules (`grep -cE "from '@/lib/" src/lib/schemas.ts`). Exporting the set from `schemas.ts` (the issue's wording) would
  give a script that fails to load in production. The list therefore moves to
  a leaf module with no imports, `src/lib/reserved-slugs.ts`. `schemas.ts`
  imports it, so there is still exactly one list.
- **CI already builds the migrate image** (`docker-build` job) and probes it
  with `--network none` against `203.0.113.1` (RFC 5737), expecting P1001.
  The same probe pattern proves that the new script loads in the image:
  reaching the connect step at all means every import resolved.
- **`Teacher.pageSlug` is `String @unique`, non-null.** Erasure rewrites it to
  `deleted-<id>`, which never clashes. Every writer goes through
  `pageSlugField`'s lowercase regex, so an exact `IN` match is complete.
- **The route test's gaps hold as the issue describes.** It looks one level
  into a route group, and it doesn't read `public/`. Today `src/app` has no
  nested groups, and `public/` holds `icons/` and `sw.js`.

## Design

1. **`src/lib/reserved-slugs.ts`** exports `RESERVED_SLUGS: ReadonlySet<string>`.
   It has no imports. Its comment carries the existing rationale, plus the one
   line the issue asks for: a `next.config` rewrite, a path the proxy routes,
   or an nginx `location` can also claim a name, no test sees those, so reserve
   the name here when one does.
2. **The route test**: route groups are walked recursively, so
   `(a)/(b)/about` yields `about`. The names of `public/`'s top-level entries
   are held against `pageSlugField` the same way. Any name that passes
   `pageSlugField` claims a path a slug could hold.
3. **`src/services/reserved-slug-holders.ts`**:
   `findReservedSlugHolders(db, reserved: Iterable<string>)` returns
   `{ teacherId, pageSlug }[]` ordered by slug. It is framework-agnostic and
   uses relative imports only, because it runs in the migrate image.
4. **`scripts/check-reserved-slugs.ts`** is a thin CLI. It calls the service
   with `RESERVED_SLUGS`, prints one line per holder (slug and teacher id) and
   a pointer to DEPLOYMENT.md §6, then exits 1. With no holders it prints one
   line and exits 0. Any error exits non-zero, which is fail-closed.
5. **Dockerfile `migrate` stage** copies the three files and becomes
   `CMD prisma migrate deploy && tsx scripts/check-reserved-slugs.ts`. The
   check runs **after** migrate because on a fresh install the `Teacher`
   table doesn't exist until then. The cost of that order is that a refused
   deploy leaves its migrations applied. §6 already requires every migration
   to work with the previous commit running against it, so that is a state
   the old app is designed to serve.
6. **CI `docker-build`** gets one step: run the script in the migrate image
   against the unreachable address and require P1001.
7. **DEPLOYMENT.md §6** gets a subsection, *A reserved page slug a teacher
   holds*. It covers what the refusal prints, that the fix is a human decision
   (move the teacher to a new slug after talking to them, or rename the
   route), and that every `up` built from the refused commit's images runs
   the check again. Like a failed migration, it leaves `app` replaced by a
   container that never starts, so run no `up` until it's resolved.

## Why in the image's CMD rather than a separate `deploy.sh` step

A separate step would keep `up`'s own `migrate` run free of the check. But it
would only take effect once the operator reinstalls the root-owned
`deploy.sh`, and it would miss a manual `up -d --build`. In the CMD, the
check is live on the next deploy and covers every path that runs migrations.
The `up` hazard is the same one a failed migration already has, and §6
already documents it.

## Out of scope

As the issue says: no SQL `CHECK` copy of the list and no profanity list.
`deploy.sh` is unchanged. Its failure message names *a failed migration*, and that subsection points on to the reserved-slug one.
