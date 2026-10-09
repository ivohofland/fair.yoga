# Admin surface scaffold: grant, host, gate, and a counts dashboard (#60)

The first slice of the platform-admin surface that #60 tracks. It builds the
three things every later admin feature stands on — who is an admin, where the
admin surface lives, and what it takes to get in — and puts one read-only page
behind them: platform counts.

Room curation, base-property change requests (#52) and duplicate-room merging
are **not** in scope. They are the reason the scaffold exists; each gets its own
spec on top of it.

## Purpose

Two jobs, in this order:

1. **Scaffolding for curation.** The grant, the host split and the gate are the
   substance of this spec; they must be right before anything writes shared
   data.
2. **An operator health check.** The operator and one or two trusted volunteers
   glance at whether the platform is alive and growing. Counts only, no
   drill-down.

## Decisions

1. **Admin is an account capability, not a profile.** It is stored as an
   `AdminGrant` row on `Account`, not as a third model beside `Teacher` and
   `Student` and not as an `isAdmin` boolean. A row can be revoked and leaves
   history; a flag flipped in place does not.
2. **Authority is keyed on `accountId`, never on an address.** No
   `ADMIN_EMAILS` allowlist: an address is something erasure rewrites (#522).
3. **Grants are made only from a shell.** No in-app route creates, revokes or
   lists grants, so there is no escalation path through the application.
4. **A separate host, same process.** The admin surface answers on
   `ADMIN_HOST` (`admin.fair.yoga` in production), served by the same Next.js
   process and container through a second Nginx `server_name`. Not a separate
   deployment: the 2 GB single-VPS constraint and the shared auth both argue
   against one.
5. **The host is a wall, not the gate.** Everything the gate checks (decision
   7) is checked regardless of host. The host split adds browser-side cookie
   separation; it is not what keeps a non-admin out.
6. **No obscurity.** The repo is public and every Let's Encrypt certificate is
   published in Certificate Transparency logs, so neither the hostname nor the
   paths are secret. What *is* withheld is whether a given account holds a
   grant: every refusal a non-grantee can reach is the same 404 a nonexistent
   route gives.
7. **The gate is strict on every admin page, reads included:** an active grant,
   a session that signed in with a passkey, and a session younger than
   `ADMIN_AUTH_WINDOW_MS` (5 minutes). The admin surface is therefore a short
   window after each passkey sign-in; re-signing in is the expected rhythm.
8. **An admin must also hold a live teacher or student profile.**
   `SessionUser` (`src/lib/types.ts`) makes a profile-less session
   unrepresentable, and passkey registration requires a profile for the
   credential's display name. An admin registers their passkey where every
   user does (`AccountSecurity`, on `/settings/profile` or `/account`). A
   volunteer who is not a teacher signs up as a student. The alternative — a
   third, account-only `SessionUser` arm — is deferred (Future, below).
9. **The first page is aggregates only.** No names, addresses or emails cross
   into it, so this PR's review is about the gate, not about which personal
   data an admin may see. Row-level admin pages get their own spec.

## Data model

```prisma
model AdminGrant {
  id        String    @id @default(uuid())
  accountId String
  grantedAt DateTime  @default(now())
  grantedBy String
  revokedAt DateTime?
  revokedBy String?

  account Account @relation(fields: [accountId], references: [id])

  @@index([accountId])
}
```

- **Active** means `revokedAt IS NULL`. A partial unique index,
  `AdminGrant_account_active_unique ON ("accountId") WHERE "revokedAt" IS
  NULL`, allows at most one active grant per account. Prisma cannot express it,
  so it is raw SQL in the migration and the model carries a `///` docblock
  naming it, as `Teacher` does for `Teacher_account_live_unique`.
- `CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL))` — the two revoke
  columns are set together or not at all.
- Rows are never deleted. Revoking stamps the row; granting again inserts a new
  one. The table is the history of who held admin and when.
- `grantedBy` / `revokedBy` are free text naming the operator who ran the
  command. The first grant has no granting admin, and grants come from a shell,
  not from a session; the server's shell history is the real audit.
- `onDelete` is left at the default (Restrict). `Account` rows are not deleted
  today — erasure acts on the profiles — and Restrict says a grant's history is
  never removed as a side effect.
- **Erasure does not revoke.** Erasing an admin's profile leaves the grant
  active but unusable (no live profile, so no session validates). The CLI
  reports such a grant as *dormant* (below). Revocation is always its own act.

## Grant CLI

Logic in `src/services/admin-grants.ts`, framework-agnostic and tested against
the test database; `scripts/admin-grant.ts` is a thin argv wrapper.

```
pnpm admin:grant  <email> --by <name>
pnpm admin:revoke <email> --by <name>
pnpm admin:list
```

| Function | Behaviour |
|---|---|
| `grantAdmin(db, { email, by })` | Resolves the email to an `Account`; refuses if none (the CLI never creates accounts) and if the account holds no passkey (an admin without one could never pass the gate). An account with an active grant answers *unchanged*. Otherwise inserts a row. |
| `revokeAdmin(db, { email, by })` | An account without an active grant answers *unchanged*. Otherwise stamps `revokedAt`/`revokedBy`. |
| `listAdmins(db)` | Every active grant with its email, `grantedAt` and `grantedBy`, and `dormant: true` when the account has no live teacher or student profile. Dormancy is derived on read, never stored. |

*Unchanged* exits 0, matching the project's "already done answers 200" rule.

**Running it in production.** The runner image is Next's standalone output —
no `tsx`, no `scripts/`. The `migrate` stage already carries the full
dependencies and Prisma, so it additionally copies the script and its service,
and the command is:

```
docker compose -f docker-compose.prod.yml run --rm migrate pnpm admin:grant <email> --by <name>
```

The `migrate` image thereby carries one non-migration tool. The Dockerfile
comment on that `COPY` says so, so it is not pruned as dead weight.

## Host routing

**Configuration.** `ADMIN_HOST` is a host with optional port, compared with the
request's `Host` header: `admin.fair.yoga` in production,
`admin.localhost:3000` in development, a per-worktree port through
`src/lib/worktree/env-overrides.ts`. **Unset, the admin surface is off:** every
admin path answers 404. That is the default for self-hosters and forks.

**The proxy cannot guard `/api`.** Its matcher deliberately excludes `/api/*`
(a matched path has its body buffered, which would defeat the photo upload's
early size refusal). So the proxy routes *pages* by host as a courtesy, and the
host check that actually holds lives in the gate.

`src/proxy.ts`, pages only:

| Host | Path | Result |
|---|---|---|
| admin host | `/admin`, `/admin/**`, no session cookie, not `/admin/sign-in` | redirect to `/admin/sign-in?redirect=…` |
| admin host | `/admin`, `/admin/**` otherwise | pass, with `X-Robots-Tag: noindex, nofollow` |
| admin host | any other page, `/` included | redirect to `/admin` |
| main host | `/admin`, `/admin/**` | pass; the page's host check renders the 404 |

Other pages on the admin host redirect rather than 404 because an admin-host
session would otherwise render teacher and student pages there. The main
host's `/admin` is left to the page-level host check, which renders the real
404 page.

URLs stay literally `/admin/…` on the admin host. No rewrite, so a `<Link
href>` never disagrees with the address bar.

## The gate

The gate is two modules. `resolveAdminAccess` in `src/lib/admin-access.ts` is
the decision, framework-free and testable without mocking `next/headers`.
`requireAdminSession()` in `src/lib/admin-session.ts` is the Next wrapper,
cached per request, that turns its answer into `notFound()` or a redirect.
Every admin page and every future admin API route calls the wrapper. In order:

1. `Host` equals `ADMIN_HOST`, else `notFound()`. Unset `ADMIN_HOST` fails here.
2. A session exists, else redirect to `/admin/sign-in?redirect=<path>`.
3. The session's account holds an active `AdminGrant`, else `notFound()`.
4. The session row's `passkeyCredentialId` is non-null **and** its `createdAt`
   is within `ADMIN_AUTH_WINDOW_MS` of now, else redirect to sign-in. Only a
   grantee reaches this branch, so the redirect discloses nothing a
   non-grantee could use.
5. Returns an `AdminProof`.

`ADMIN_AUTH_WINDOW_MS` is its own constant (5 minutes), not
`RECENT_AUTH_WINDOW_MS`, whose docblock defines it as the passkey-adding rule.
Both are measured from `Session.createdAt`, for the reason
`docs/technical-architecture.md` (Session Management → Recent authentication)
gives.

**`AdminProof`** is `{ accountId, sessionId }` branded with a `declare const
… : unique symbol` and also bound at runtime: it is minted only in
`admin-access.ts`, frozen and recorded in a `WeakSet`, and admin services call
`assertAdminProof` on it. The brand is erased at runtime and an `as AdminProof`
cast passes every type check, so the `WeakSet` is what refuses a cast literal or
a spread copy. Admin services take the proof as a parameter, so a route that
skips the gate does not compile.
Because step 1 runs first, no code path can obtain a proof on the wrong host,
whether or not it sits inside the `(admin)` route group.

**Sign-in.** `/admin/sign-in` offers one passkey button and no email field. It
calls the existing `/api/auth/passkey/authenticate/*` routes, which already
answer on any host. Two changes there:

- `getExpectedOrigin()` (`src/lib/auth/passkey.ts`) returns
  `[NEXT_PUBLIC_APP_URL, adminOrigin]` when `ADMIN_HOST` is set, one origin
  otherwise. `@simplewebauthn/server` accepts an array.
- Production sets `PASSKEY_RP_ID=fair.yoga`, the registrable parent of both
  hosts, so a passkey registered on the main host signs in on the admin host.
  Nothing is in production yet, so no existing credential is stranded.

Sign-out is the existing `SignOutButton` (`src/components/account/sign-out-button.tsx`) with `redirectTo` `/admin/sign-in`, a client navigation.

**What the host split buys, and what it does not.**

- It buys: the two hosts' session cookies are host-only (no `Domain`
  attribute), so the browser never sends the admin cookie to the main host or
  the reverse.
- It does not buy: protection against a stolen session token, which a client
  can present on either host. The recency window is what bounds that.
- The two hosts are **same-site, cross-origin**. `SameSite` therefore does not
  separate them: a script on the main host can make a credentialed request to
  the admin host. CORS keeps it from reading the response, and
  `crossOriginRefusal` (`src/lib/cross-origin.ts`) refuses a write through its
  `host-mismatch` branch — not its `sec-fetch-cross-site` branch, since the
  browser sends `Sec-Fetch-Site: same-site`.

## Dashboard

**Service.** `src/services/admin-metrics.ts`:

```ts
export interface PlatformCounts {
  teachers: number;
  students: { withAccount: number; walkInOnly: number };
  rooms: { public: number; private: number };
}

export async function getPlatformCounts(
  proof: AdminProof,
  db: PrismaClient,
): Promise<PlatformCounts>;
```

| Field | Counts |
|---|---|
| `teachers` | `Teacher` with `deletedAt IS NULL` |
| `students.withAccount` | `Student` with `deletedAt IS NULL AND accountId IS NOT NULL` |
| `students.walkInOnly` | `Student` with `deletedAt IS NULL AND accountId IS NULL` (unclaimed walk-ins) |
| `rooms.public` | `Room` with `isPublic = true` |
| `rooms.private` | `Room` with `isPublic = false` |

- The counts run in one `$transaction([...])` at `RepeatableRead`, so they read one snapshot; the default Read Committed would give each statement its own.
- Totals are derived by the page, never returned, so a total cannot disagree
  with its parts.
- `proof` is checked, not used: the service calls `assertAdminProof(proof)`
  first, so a caller holding a forged or spread-copied proof is refused before
  any count runs.

**Routes.**

```
src/app/(admin)/admin/
  (gated)/layout.tsx   ← requireAdminSession(); header and sign-out; no tab bar
  (gated)/page.tsx     ← the dashboard; calls requireAdminSession() for its proof
  sign-in/page.tsx     ← outside (gated), so it never redirects to itself
```

The page calls the gate itself, not only through the layout: App Router
renders a layout and its page concurrently, so the layout's redirect does not
stop the page's data fetch. The layout's call is the user-facing redirect; the
page's is the one that guards the data. Rendering is dynamic on every request;
nothing is cached.

**Look.** The 640 px column on cream. A Georgia heading, *Platform*, with a
caption naming the signed-in address and a text *Sign out* button. Three
sand-soft cards (radius 16, 1 px border) — Teachers, Students, Rooms — each
with the total in `type-number`. Students and Rooms carry their split as a
`type-caption` line: "with an account 291 · walk-in only 27", "public 19 ·
private 42". No navigation (one page needs none), no trends, deltas or charts.

## Testing

**The passkey ceremony cannot run on `admin.localhost`.** A spike measured it:
Chrome refuses the WebAuthn ceremony there with `The RP ID "localhost" is
invalid for this domain`, so locally the admin passkey sign-in cannot complete.
Production, with `PASSKEY_RP_ID` set to the parent domain and the admin host a
subdomain of it, is the standard registrable-parent case. Tests therefore seed a
session bound to the grantee's passkey credential, as the ceremony would leave
it (`seedPasskeySession`, `tests/admin-fixtures.ts`), and the admin origin's
acceptance by the registration and authentication verifiers is pinned by the
passkey unit test. The first real
sign-in is the post-deploy smoke test in `DEPLOYMENT.md` (Admin access).

**Vitest, test-first, against the test database.**

- `admin-grants.ts`: grant; revoke; grant again after revoke inserts a new row;
  grant of an active account and revoke of an inactive one answer unchanged;
  refusal for an unknown address and for an account without a passkey;
  `listAdmins` marks a grant dormant once the account's only profile is erased.
- The partial unique index refuses a second active row **inserted directly**,
  bypassing the service — otherwise the service's own pre-check keeps the test
  green even if the index is missing.
- `requireAdminSession`: one test per step — wrong host and unset `ADMIN_HOST`
  (404); no session (redirect); no grant and revoked grant (404); magic-link
  session and passkey session past the window (redirect); the happy path
  (proof). Each refusal is mutation-tested: removing its check turns exactly
  its test red.
- `getPlatformCounts`: fixtures with an erased teacher, an erased student, a
  claimed student, an unclaimed walk-in, and public and private rooms, with
  **no two expected counts equal**, so a swapped field cannot pass. The counts
  are whole-table, so the test runs through a `scopeSweep` client narrowed to
  its own rows, which keeps exact numbers in the parallel tier.
- An `@ts-expect-error` test: `getPlatformCounts` refuses a hand-built
  `{ accountId, sessionId }`.
- `getExpectedOrigin()`: one origin with `ADMIN_HOST` unset, two with it set.
- `admin-host.ts` imports only the dependency-free `safe-path.ts`, so the proxy
  stays light; a tether test pins its imports.
- The session `Set-Cookie` carries no `Domain` attribute — the host-only
  isolation is otherwise a default nobody wrote down.
- `crossOriginRefusal`: a write from the admin origin to the main host, and the
  reverse, each with `Sec-Fetch-Site: same-site`, is refused as
  `host-mismatch`.
- `proxy.ts`: one test per row of the host-routing table.

**Playwright.** An `admin` project whose `baseURL` is the admin host: a grantee
with a seeded passkey-signed session sees the dashboard; a signed-in
non-grantee gets the 404 page; the main host's `/admin` answers 404. There is
no visual baseline: the dashboard shows whole-database counts, which a
screenshot cannot hold stable.

**Census guards the route trips.** Named in the plan task that adds the route,
not discovered at the end:

- `src/lib/loading-coverage.test.ts` (`FALLBACK_ROUTES`) — the new pages, or a
  recorded decision that the admin group has no `loading.tsx`.
- `src/lib/list-row-recipe.test.ts` (`SPLIT_RECIPE_SITES`) — only if the page
  renders rows; the design uses cards.

## Documentation in the same PR

- `docs/data-model.md`: `AdminGrant`, what active means, the partial unique
  index, the profile requirement and dormancy.
- `docs/technical-architecture.md` (Admin surface): the admin host, the gate's
  order, what the host split does and does not buy, and the local passkey
  limit.
- `DEPLOYMENT.md`: DNS record, second `server_name`, the certificate's extra
  name, `ADMIN_HOST`, `PASSKEY_RP_ID`, the grant command, the post-deploy
  passkey smoke test, and an optional Nginx IP allowlist for the admin vhost as
  an operator choice.
- `deploy/nginx.conf.example`: the admin `server` block.
- `docs/information-architecture.md`: one line — the admin surface sits outside
  the four-tab IA.

## Future (not this spec)

- **Account-only sessions.** A third `SessionUser` arm would let an admin hold
  no yoga profile. Deferred because the union is narrowed across the whole app
  and the admin host would need its own passkey-registration path with its own
  recent-auth step.
- **Host-bound sessions.** A `Session` column marking a session minted on the
  admin host, required by the gate, would stop a main-host passkey session from
  passing step 4 within its own window. Marginal for a new column; revisit when
  admin writes exist.
- **Admin audit log.** Every admin write recorded with before and after. Lands
  with the first write, which this spec has none of.
- Room curation, #52 change requests, duplicate-room merge.
