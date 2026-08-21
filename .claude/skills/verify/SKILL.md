---
name: verify
description: Build/launch/drive recipe for verifying fair.yoga changes in the running app
---

# Verifying fair.yoga in the running app

## Launch

- Postgres runs in Docker as `fairyoga-db-1` on :5432 (`DATABASE_URL` in `.env`).
- The user often already has `next dev` running on :3000 (check `lsof -nP -iTCP:3000 -sTCP:LISTEN` before starting your own). Hot reload means uncommitted edits are already live there.
- Otherwise: `EMAIL_DRY_RUN=1 npm run dev` — dry-run logs magic links to stdout instead of Resend (`.env` only has a placeholder Resend key, so real sends fail).

## Authenticate without email

Sessions are DB rows: `id` = sha256-hex of a random token, cookie `fair_yoga_session=<raw token>`. `Session` keys on `accountId` (not on `Teacher`/`Student` — look up the account first). Mint one directly (seeded teacher: `ivo@fairyoga.dev`):

```ts
const teacher = await prisma.teacher.findUniqueOrThrow({ where: { email: 'ivo@fairyoga.dev' } });
const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
await prisma.session.create({ data: { id: hash, accountId: teacher.accountId, expiresAt: new Date(Date.now() + 86400_000) } });
// Playwright: addCookies([{ name: 'fair_yoga_session', value: token, url: 'http://localhost:3000' }])
```

Delete the session row when done. (`tests/helpers.ts`'s `seedSession(db, accountId)` does the same thing for the test suites; `src/lib/auth/session.ts`'s `createSession` is the production path.)

## Drive (Playwright)

- `@playwright/test` is a dev dep; drive with a plain `chromium.launch()` script via `npx tsx`.
- Scripts outside the repo (scratchpad) need `NODE_PATH=<repo>/node_modules` to resolve `@prisma/client`/Playwright.
- **Never wait for `networkidle`** — the app holds an SSE connection (LiveUpdates) open forever. Use `waitUntil: 'load'` + wait for a concrete locator.
- `npx tsx -e "..."` is CJS: no top-level await; use `.then()` or an async `run()`.

## Gotchas

- `next dev` compiles lazily per route: the first request after a source edit pays compilation and can blow vitest's 5s default (`vitest.config.ts` sets no `testTimeout`) or Playwright's 5s `expect` budget (`playwright.config.ts` sets no `expect.timeout`). Warm each touched route once (bare `curl`) before running gates or scoring mutations — a RED immediately after an edit is a cold route until proven otherwise (#290).
- Notification titles are NOT unique — dev DB accumulates hundreds of e.g. "Payment received" rows from past testing. Scope any test-data mutation by `id` (capture the pre-state first), never by title.
- `npm run db:seed` wipes and recreates all domain data — the reset hammer if test-data surgery goes wrong.
- Judge visuals by measuring the DOM (`getBoundingClientRect`), not by eyeballing zoomed screenshots.
