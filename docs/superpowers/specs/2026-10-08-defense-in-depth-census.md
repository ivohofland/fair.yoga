# #770 premise census (read-only)

Worktree `/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-770`, HEAD `bcabcc81`, Next `16.3.4`
(`node -p "require('next/package.json').version"`). All commands run from the worktree root. No PR for #770 exists yet
(`gh pr list --state all --search 770`).

---

## 1. CSP: the premise holds. A nonce costs little, but the proxy has to be restructured

### Current policy (`next.config.ts:13-25`, applied to `/(.*)` at `:68`)
| Directive | Value |
|---|---|
| default-src | `'self'` |
| script-src | `'self' 'unsafe-inline'` (+ `'unsafe-eval'` in dev) (`:15`) |
| style-src | `'self' 'unsafe-inline'` (`:16`) |
| img-src | `'self' data: blob:` (EPC QR) |
| font-src | `'self'` |
| connect-src | `'self'` (+ `ws:` in dev) |
| frame-ancestors | `'none'` |
| base-uri | `'self'` |
| form-action | `'self'` |
| object-src | `'none'` |

There is no `worker-src`. The comment at `next.config.ts:5-12` records the original decision ("a nonce-based policy needs
middleware-driven per-request nonces — heavier than this app warrants"), which came in with `67d598d1` (2026-07-18,
`git log -S "heavier than this app warrants" -- next.config.ts`). No doc or issue records that decision anywhere else.

### Inline script and style the app emits
- **App-authored inline script: none.** `grep -rn "dangerouslySetInnerHTML" src` and
  `grep -rnE "<script|next/script|application/ld\+json" src` both return 0 non-test hits. No theme or no-flash script,
  no JSON-LD and no structured data exist. The root layout (`src/app/layout.tsx:22-40`) has no script.
- **Service worker registration** runs from client modules, not inline (`src/lib/offline-client.ts:13`,
  `src/lib/push-client.ts:150`).
- **Next's own inline scripts.** Measured on the dev server at :3000 (`curl -s http://localhost:3000/login`): 3 inline
  `<script>` tags (`self.__next_r=…`, which is dev-only, plus 2 `self.__next_f.push(...)` flight chunks) and 19 `src=`
  scripts. Next stamps the nonce on all of these itself.
- **Inline style attributes:** 11 `style={…}` sites in 5 files (`grep -rn "style={" src --include='*.tsx' | grep -v
  '\.test\.'`): `global-error.tsx` (5), `verify/page.tsx:100`, `registration-progress.tsx:43,48` (the progress-bar
  width and tick, which are dynamic values), `icon.tsx:98`, `avatar.tsx:46,57`. There are no `<style>` tags in source.
  The SW offline page (`public/sw.js:25-33`) uses style attributes but sends its own CSP (`sw.js:58`,
  `default-src 'none'; style-src 'unsafe-inline'`), so a page CSP does not touch it.
- **The fix must leave style-src alone.** Under CSP3, a nonce in style-src makes the browser ignore `'unsafe-inline'`,
  and that would break every style attribute above. Next's guide example (`style-src 'self' 'nonce-…'`) would break the
  progress bar. Tailwind v4 compiles to a stylesheet, so it needs no inline styles itself.

### How Next 16.3.4 applies a nonce
- `node_modules/next/dist/server/app-render/app-render.js:209-210` reads the nonce from the **request**
  `content-security-policy` header (or `-report-only`) through `getScriptNonceFromHeader`
  (`app-render/get-script-nonce-from-header.js`). That function takes the first `'nonce-…'` in `script-src`, falling
  back to `default-src`.
- So the proxy has to set the CSP on the request headers, not only on the response. `x-nonce` is only a convenience for
  app code; Next itself does not need it.
- The local guide (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`) adds:
  - `:38`/`:181`: nonces require dynamic rendering.
  - `:395`: static optimisation and ISR are disabled.
  - `:397`: PPR is incompatible.
  - `:456+`: an experimental SRI alternative keeps pages static.

### Cost: which routes are static today
- **Already dynamic:** `export const dynamic = 'force-dynamic'` appears on 15 pages
  (`grep -rnE "export const (dynamic|revalidate)|generateStaticParams" src/app`; there is no `generateStaticParams` and
  no `revalidate`). Every other page reads `getSession()` / `cookies()` / `headers()`, either directly or through the
  `(teacher)`/`(student)` layouts (`(teacher)/layout.tsx:19-21`, `(student)/layout.tsx:11-15`). `src/app/page.tsx:87`,
  `signup/page.tsx:31`, `signup/profile/page.tsx:37,55` and `start/page.tsx:12` are dynamic as well.
- **Static today:** `/login` and `/verify` (`'use client'` with `useSearchParams`, under the `(public)` layout, which
  has no dynamic API), `/_not-found` and `/_global-error`, plus the icons and the manifest. This matches
  `/Users/ivohofland/Projects/fair.yoga/.next-build/prerender-manifest.json` (a stale build from 2026-09-15:
  `/_global-error /_not-found /apple-icon.png /icon.svg /login /verify`).
- **Effect of a nonce:** `/login`, `/verify` and the 404 page lose prerendering. They must be forced dynamic, for example
  with `await connection()` / `headers()` in the root layout. Otherwise their prerendered HTML has no nonce and every
  script on them is blocked. Nothing uses ISR or PPR today, so nothing else is lost.
- **Offline / PWA:** `public/sw.js` stores a page together with its own `content-security-policy` header (`KEPT_HEADERS`
  at `sw.js:66-73`, `storedHeaders` at `:75-84`). A replayed page therefore carries a nonce and a CSP that match each
  other, so there is no stale-nonce mismatch. The nonce is replayed for at most `MAX_AGE_MS` = 24 h (`sw.js:11`), but
  the body is replayed with it and never re-rendered, so nothing new can borrow it. Only `/schedule`, `/class/*` and
  `/studio-class/*` are cached (`sw.js:44-46`).
- **Verify `worker-src`:** with `'strict-dynamic'`, `'self'` is ignored in script-src, and `worker-src` falls back to
  script-src. Confirm that `navigator.serviceWorker.register('/sw.js')` still succeeds, or add an explicit
  `worker-src 'self'`.

### The `src/proxy.ts` matcher, and what it misses
- The matcher (`src/proxy.ts:26-38`) has 9 prefixes: schedule, studio-class, students, inbox, settings, class,
  bookings, account, updates. `src/proxy.test.ts:114-128` pins that list with `toEqual`.
- **Pages it misses:**
  - `/` (`src/app/page.tsx`)
  - `/login`, `/verify`, `/signup`, `/signup/profile`, `/start`
  - `/[slug]` and `/[slug]/book/[classId]`
  - the not-found and global-error pages

  List them with `find src/app -name page.tsx | grep -v api`.
- **The proxy has to split before the matcher can widen.** Today the proxy's whole job is to redirect to `/login` when
  there is no session cookie (`proxy.ts:10-14`). Widening the matcher for the nonce would put the auth redirect on public
  pages. `/start` in particular must stay outside the auth redirect (`tests/integration/pwa.test.ts:81-84`, and
  `docs/technical-architecture.md`, Authentication Flow → Installed app start URL). The proxy therefore needs a
  CSP-for-every-page path and a redirect-only-for-protected-prefixes path. The matcher test changes shape too.
- **Duplicate CSP header.** `next.config.ts:68` still puts a static CSP on `/(.*)`. If the proxy also sets one, a page
  can end up with two CSP headers. The browser enforces both, so the static one stays harmless but redundant, and the
  pattern is confusing. The usual fix is to restrict the config rule to `/api/*` and non-page routes.
  `tests/integration/security-headers.test.ts:9-30` asserts only the parts that do not change (`default-src`,
  `frame-ancestors`, `object-src`, `form-action`). Nothing pins `unsafe-inline`, its absence, or a single header.

---

## 2. CSRF: the premise holds as written, but the fix as proposed protects only part of the surface

### parseBody
- `src/lib/api-utils.ts:159-176` calls `request.json()` with no Content-Type check. It has **39 call sites**: 37 in 36
  route files (`grep -rn "parseBody(" src/app | grep -v '\.test\.' | wc -l`) and 2 in
  `src/lib/auth/profile-authorization.ts:118,243`.
- Two other body readers bypass it:
  - `src/app/api/teachers/[id]/photo/route.ts:37` uses `request.formData()` (multipart, sent by
    `profile-photo-field.tsx:59`).
  - `src/app/api/students/[id]/route.ts:180` uses `request.text()` then `JSON.parse` (`readArchiveBody`).

### What clients send
- The census is in `scratchpad/bodyscan.mjs`, which scans every `fetch(` in non-test `src` with a 14-line window.
  **Every fetch that sends a body also sets `'Content-Type': 'application/json'`.** The only exceptions are the photo
  upload, where the browser sets the multipart type, and `archive-student-button.tsx:20`, which sets the header only
  when it sends a body.
- No source file uses `navigator.sendBeacon`, `XMLHttpRequest`, or a native `<form action>` / `method="post"`
  (`grep -rnE "sendBeacon|XMLHttpRequest|<form[^>]*action=" src`). `public/sw.js` only issues GETs (`sw.js:344`).
- **Tests:** `scratchpad/testbodyscan.mjs` lists every `body: JSON.stringify` under `tests/` and `src/`. The 6 hits in
  `tests/integration` without a header nearby use a `headers` variable that does carry `'Content-Type':
  'application/json'` (checked at `invitations-api.test.ts:1009-1012` and `students-api.test.ts:1952-1955`). The `src/`
  hits are component tests with a mocked `fetch`. e2e makes no raw POSTs; it drives the UI.
- **Verdict:** requiring `application/json` in `parseBody` breaks no client found. Allow `application/json;
  charset=…`.
- **But the requirement does nothing for the bodyless POST handlers** that never call `parseBody`, 11 in all:
  - `passkey/authenticate/options`, `passkey/register/options`
  - `classes/[id]/cancel`, `classes/[id]/complete`
  - `invitations/[id]/resend`, `notifications/[id]/read`
  - `payments/[id]/not-charged`, `payments/[id]/remind`, `payments/[id]/unpaid`
  - `rooms/[id]/publish`
  - `teachers/[id]/photo` (multipart, which is a CORS-simple type)

  To list them, compare the files exporting POST/PUT/PATCH/DELETE with the files calling `parseBody`:
  `comm -23 <(grep -rlE "export (const|async function) (POST|PUT|PATCH|DELETE)" src/app/api | sort) <(grep -rl
  "parseBody(" src/app/api | grep -v '\.test\.' | sort)`. That lists 25 files, 11 of them with POST once the cron
  routes are excluded.

  A cross-site form can only send GET or POST; PUT, PATCH and DELETE need a preflight. So these POSTs are the real
  CSRF surface, and only an Origin check covers them.
- **Origin / Referer check:** none exists. `grep -rn "headers.get('origin')\|get('referer')\|sec-fetch" src` returns
  0. There are no server actions (`grep -rl "'use server'" src` returns 0), so Next's built-in action Origin check does
  not apply.
- **What an Origin check must allow:**
  - A missing `Origin`: Node `fetch` in the integration suite sends none, and neither does curl for cron.
  - The cron routes, or an exemption for requests carrying the Bearer token.

  The expected origin is available as `NEXT_PUBLIC_APP_URL` (already used by `passkey.ts:189-191`; worktrees set it per
  port in `src/lib/worktree/env-overrides.ts:8`).

### Cookies
All three cookies have the same shape: `HttpOnly; SameSite=Lax; Path=/; Max-Age=…`, no Domain, and **`Secure` only
when `NODE_ENV === 'production'`**.

| Cookie | Name constant | Set / clear |
|---|---|---|
| session | `fair_yoga_session` (`src/lib/auth/session.ts:10`) | `:198-212` |
| origin nonce | `fair_yoga_origin` (`src/lib/auth/origin-nonce.ts:13`) | `:47-60` |
| signup ticket | `fair_yoga_signup` (`src/lib/auth/signup-ticket.ts:6`) | `:89-97` |

**Where the session name lives.** It is defined four times, independently:
- `src/lib/auth/session.ts:10` (exported)
- `src/proxy.ts:5` (a deliberate duplicate)
- `src/lib/session.ts:10` (a bare literal in `getSession()`)
- `tests/helpers.ts:65`

The literal `fair_yoga_session` appears on 116 lines across the repo
(`grep -rn "fair_yoga_session" --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.next-build --exclude-dir=.git
. | wc -l`), 70 of them in src or tests outside the three source definitions. It is also in `AGENTS.md:80`,
`.claude/skills/verify/SKILL.md:33,40` and about 20 plan or spec docs.

The constant `SESSION_COOKIE_NAME` is imported or defined in 6 files (`grep -rln "SESSION_COOKIE_NAME" src tests
scripts`). The signup cookie name is used in 15 files and the origin cookie name in 11 (`grep -rln
"fair_yoga_signup\|SIGNUP_TICKET_COOKIE" src tests` and `grep -rln "fair_yoga_origin\|ORIGIN_NONCE_COOKIE" src tests`).

### The `__Host-` rename
- `__Host-` requires `Secure`, `Path=/` and no `Domain`. `Path=/` and no Domain already hold. **`Secure` must become
  unconditional.** That reverses a pinned decision: `src/lib/auth/origin-nonce.test.ts:45-49` reads "omits Secure outside
  production, so local http dev works". `session.test.ts:705-716` pins the literal name.
- **http://localhost:**
  - Chromium accepts Secure cookies on localhost. CI already proves it: the e2e job runs the production build
    (`NODE_ENV=production`, so `Secure` is set) over `http://localhost:3000`, Chromium only (`.github/workflows/ci.yml:420`,
    `playwright.config.ts:65-67`).
  - Firefox accepts them too.
  - **Safari on http://localhost is unverified.** This repo has a Safari dev history (#127, `next.config.ts:69-73`).
    Test it before committing.
  - Dev over a LAN IP would lose the cookie entirely. No doc or script uses one (`allowedDevOrigins` or `-H 0.0.0.0`
    is absent from `package.json` and the docs).
- **Playwright:** `sessionCookie()` (`tests/helpers.ts:89-91`) passes `{name, value, url: http://localhost…}`, so
  Playwright infers `secure: false`, and Chromium rejects a `__Host-` cookie without Secure. The helper must pass
  `secure: true, path: '/'` explicitly. It has 37 `addCookies` call sites (`grep -rn "addCookies" tests/e2e | wc -l`),
  most of them through this helper.
- **Existing sessions:** everyone is signed out once, and the old DB rows expire through the existing auth cleanup.
  The app is not in production, so nothing else is affected. The SW clears its stored pages on the resulting redirect
  (`sw.js:267,299`).

---

## 3. Cron: the premise holds; the issue's nginx snippet is incomplete and breaks a documented command

- **Comparison:** `src/lib/cron-auth.ts:11` is `if (auth !== \`Bearer ${secret}\`)`. There is no `timingSafeEqual`
  anywhere in src (`grep -rn "timingSafe\|constantTime" src` returns 0).
- **Callers:** 6 routes, not 5. `ls src/app/api/cron` lists class-reminders, daily-cleanup, email-fallback,
  generate-classes, payment-reminders and transition-classes, each calling `requireCronAuth` (`grep -rn
  "requireCronAuth" src | grep -v test`). The docblock in `src/lib/cron-auth.test.ts:6` says "all five", which is
  already stale.
- **Rate limit:** none. `grep -rln "rateLimit\|rate-limit" src/app/api/cron src/lib/cron-auth.ts` returns 0.
- **Production trigger:** the in-process scheduler (`src/lib/scheduler.ts:5-8`) calls the services directly, with no
  HTTP and no CRON_SECRET.
- **HTTP callers of `/api/cron/*`:**
  - A human, by hand. `DEPLOYMENT.md:95-104` documents
    `curl --fail -X POST -H "Authorization: Bearer $CRON_SECRET" https://yourdomain.example/api/cron/daily-cleanup`,
    which goes **through nginx**.
  - The e2e test `tests/e2e/recurring.spec.ts:167` (BASE_URL = `localhost:3000`, which bypasses nginx).
  - No other HTTP caller (`grep -rn "api/cron" tests DEPLOYMENT.md .github`).
- **nginx:** `deploy/nginx.conf.example` has no `/api/cron` block. Everything goes through `location /` (`:43-49`).
- **Blast radius of the proposed `location /api/cron/ { allow 127.0.0.1; deny all; }`:**
  1. **It breaks the documented command.** A curl from the VPS to its own public hostname arrives from the public IP,
     not 127.0.0.1. `DEPLOYMENT.md:103` must change to `http://127.0.0.1:3000/api/cron/…`, which bypasses nginx because
     the app binds `127.0.0.1:3000` (`docker-compose.prod.yml:47-49`).
  2. **As written, the block has no `proxy_pass`.** An allowed request would be served by nginx itself, not the app.
     Since loopback callers bypass nginx anyway, a plain `deny all;` (or `return 404;`) is enough.
  3. Precedence: the only regex location is the photo route (`:33`), so a prefix `/api/cron/` block is not shadowed.

  CI and e2e never touch nginx. Whether to add a rate limit is a separate choice; `checkIpRateLimit` exists for it.
- **Tests:** `src/lib/cron-auth.test.ts` (6 cases) pins behaviour, not the comparison method. Swapping in
  `timingSafeEqual` will not show up in any test. A mutation back to `!==` is an equivalent mutant for every observable
  test, so record that in review rather than expect red.

---

## 4. Health: the premise is accurate, but a design decision deliberately made the endpoint public, and its contract is pinned in docs

- **Response shape** (`src/app/api/health/route.ts:20-56`):
  - `{status, db, jobs: {<name>: {lastRunAt, lastSuccessAt, healthy}}, degradations: {open}}`
  - On a DB failure: 503 `{status:'degraded', db:'down', jobs}`
  - When the degradation count fails: `degradations` is omitted
  - **`status: 'degraded'` from an unhealthy job still answers HTTP 200.** Only a DB outage gives 503.
- **"Public by design" is a recorded decision:**
  - the route docblock (`route.ts:10-19`)
  - `docs/superpowers/specs/2026-10-02-degradation-events-design.md:50-53` (constraint "C — `/api/health` is public by
    design") and `:155-164` (only a bare count, "so the endpoint stays public")
  - `DEPLOYMENT.md:144` ("a bare count … so the endpoint stays public")

  The per-job detail was shaped by #711 (`git log --oneline -i --grep=health`: `fbd39bbf`, `a0d769a5`…) and #157
  (`e0f671a8`, `a30f0581`).
- **Consumers and what each reads:**

  | Consumer | Reads |
  |---|---|
  | `.github/workflows/ci.yml:315,429`, `e2e-flake-repro.yml:134` | `curl -sf` readiness, HTTP status only |
  | `tests/integration/security-headers.test.ts:27-29` | headers only |
  | `src/app/api/health/route.test.ts` | `body.status`, `db`, `jobs.<name>` (full objects), `degradations` |
  | `DEPLOYMENT.md:36` | example body including `jobs` |
  | `DEPLOYMENT.md:91-93` | `CRON_SCHEDULER=off` is visible as an empty job list |
  | `DEPLOYMENT.md:129-138` | `jobs.<name>.healthy`, "Point your uptime monitor here" (`:157`) |
  | `docs/technical-architecture.md:1128,1193,1210-1214,1369` | job and degradation semantics |
  | `docs/lock-order.md:984` | job semantics |

  `deploy/` has no monitoring config and the repo has no uptime-check script.
- **Comments elsewhere:** 19 lines in `src/services` and `src/lib/scheduler.ts` state what `/api/health` reports
  (`grep -rn "api/health" src/services src/lib/scheduler.ts | wc -l`). These stay true if the authenticated variant
  keeps the per-job detail, but any comment saying "public" has to move.
- **Blast radius of "status/db public, jobs behind CRON_SECRET":**
  - CI is untouched.
  - `route.test.ts` changes.
  - `DEPLOYMENT.md` §2, §5 and §7 and the two specs' "public" claims need edits.
  - An external uptime monitor loses the per-job breakdown but keeps the aggregate, provided it reads the body's
    `status`, because `status` already folds in job health.
- **Blast radius of "nginx IP allow-list":** no code changes. The operator has to know the monitor's IP, and the doc
  says "point your uptime monitor here".

---

## 5. Dev Postgres: the premise holds as written. Binding to 127.0.0.1 breaks nothing found, with one IPv6 caveat

- **Dev compose** (`docker-compose.yml:11-16`): `ports: '5432:5432'`, user `yoga`, password `yoga_dev_password`. Live
  binding today, from `docker ps`: `fairyoga-db-1 0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp`, so all interfaces on
  both IPv4 and IPv6.
- **Production compose:** a separate file, `docker-compose.prod.yml`. Its db has no published ports (`:20-21`), the
  password is required from `.env` (`:17`), and the app binds `127.0.0.1:3000` (`:47-49`). DEPLOYMENT only ever uses
  `-f docker-compose.prod.yml` (`DEPLOYMENT.md:35,75,122,198`), so the dev compose does not run on the VPS by
  instruction.
- **Stale doc:** `docs/technical-architecture.md:1253-1280` has a section titled "docker-compose.yml (production)"
  that shows the app on `"3000:3000"` (all interfaces) and a different env shape. It describes neither real file and
  should be fixed or dropped alongside this item.
- **Who connects:**
  - `.env.example:2,5` and `scripts/worktree-setup.ts:10` use `postgresql://yoga:yoga_dev_password@localhost:5432`.
  - Nothing connects through `host.docker.internal`, `172.17.*` or a container IP (`grep -rnE
    "host\.docker\.internal|@db:5432|172\.17\." --exclude-dir=node_modules --exclude-dir=docs .` matches only the
    production compose's internal `@db:5432`).
  - CI uses its own `services: postgres` with `ports` on the runner (`ci.yml:170-188,257-276,359-378`), not this file.
  - `src/lib/service-image-scan.test.ts:91-97` reads `docker-compose.yml` for the image digest only, so a ports edit
    does not affect it.
- **Caveat:** `'127.0.0.1:5432:5432'` drops the `[::]` listener. On macOS, `localhost` resolves to `::1` first.
  libpq and Prisma's engine fall back to 127.0.0.1, but verify with `pg_isready -h localhost` and a `prisma migrate
  status` afterwards. Alternatively, publish both `127.0.0.1:5432:5432` and `'[::1]:5432:5432'`.

---

## CI overlap (`.github/workflows/ci.yml`)
- **Item 1:** only `tests/integration/security-headers.test.ts` (invariant CSP parts) checks CSP.
- **Item 2:** no CSRF or Origin check.
- **Item 3:** the e2e run of `/api/cron/generate-classes` uses `CRON_SECRET: ci-cron-secret` (`ci.yml:192,276,378`)
  and does not pass through nginx.
- **Item 4:** readiness polling uses only the status code (`:315,:429`).
- **Item 5:** CI never uses `docker-compose.yml`.

Supply-chain checks (`check-service-image-freshness`, `:123`) read compose image pins, not ports.

---

## Appendix: the two scan scripts, verbatim

`scratchpad/…` above refers to these files. Run each with `node <file> <worktree root>`.

### bodyscan.mjs

```js
import fs from 'fs';
import path from 'path';
// Lists every fetch(...) call in src (non-test) and whether its call window
// carries a body and a Content-Type header.
const root = process.argv[2];
const out = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js)$/.test(e.name) && !/\.test\./.test(e.name)) scan(p);
  }
}
function scan(p) {
  const L = fs.readFileSync(p, 'utf8').split('\n');
  L.forEach((l, i) => {
    if (!/\bfetch\(/.test(l)) return;
    const w = L.slice(i, i + 14).join('\n');
    // stop window at first line that closes the call: crude
    const method = (w.match(/method:\s*['"](\w+)['"]/) || [])[1] || 'GET?';
    const body = /\bbody[:,\s]/.test(w);
    const ct = /Content-Type/i.test(w) || /init\.headers|headers:\s*\w/.test(w);
    out.push(`${method.padEnd(6)} body=${body ? 'Y' : 'n'} ct=${ct ? 'Y' : 'n'} ${path.relative(root, p)}:${i + 1}`);
  });
}
walk(path.join(root, 'src'));
console.log(out.join('\n'));
```

### testbodyscan.mjs

```js
import fs from 'fs';
import path from 'path';
// For every `body: JSON.stringify` line under tests/, report whether a
// Content-Type header appears within 8 lines either side.
const root = process.argv[2];
const rows = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) scan(p);
  }
}
function scan(p) {
  const L = fs.readFileSync(p, 'utf8').split('\n');
  L.forEach((l, i) => {
    if (!/body:\s*JSON\.stringify/.test(l)) return;
    const w = L.slice(Math.max(0, i - 8), i + 8).join('\n');
    const ct = /content-type/i.test(w);
    rows.push(`${ct ? 'CT' : 'NO'} ${path.relative(root, p)}:${i + 1}`);
  });
}
walk(path.join(root, 'tests'));
walk(path.join(root, 'src'));
console.log(rows.join('\n'));
```
