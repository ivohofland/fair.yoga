# Defense-in-depth hardening (#770) — design

The premise is measured in `2026-10-08-defense-in-depth-census.md`, which sits beside this file. All five of the issue's premises hold. What the census adds is the cost of each fix, and this file decides on that basis.

## 1. What the census changed about the issue

- **CSP.**
  - The app emits no inline script of its own. Next's bootstrap scripts are the only inline ones, and Next 16.3.4 stamps them with the nonce it reads from the *request's* `Content-Security-Policy` header — which exists only on a request-time render.
  - Only `/login`, `/verify` and the 404 page are static today, and nothing uses ISR or PPR.
  - The service worker caches each page together with its own response headers, so a cached page carries a matching CSP and nonce.
  - The prior decision in `next.config.ts` ("heavier than this app warrants") assumed a broader rendering cost than exists. It is reversed here.
- **The proxy has to be split, not just widened.** Its matcher misses `/`, `/login`, `/verify`, `/signup*`, `/start` and `/[slug]*`. `/start` must stay outside the sign-in redirect, so "which paths get a CSP" and "which paths require a session" become separate questions in one proxy.
- **The proxy must not cover `/api/*`.** A path the proxy matches has its request body buffered by Next (up to 10 MB) before the route runs. That would undo the photo route's early refusal of an oversized upload and turn concurrent large POSTs into memory pressure on a 2 GB VPS. So everything API-side — the Origin check, the API CSP — happens outside the proxy.
- **`style-src` keeps `'unsafe-inline'`.** There are eleven `style={}` sites, including the dynamic progress bar. Style injection is not script execution.
- **CSRF.** Requiring `application/json` in `parseBody` breaks no client, but it misses 11 state-changing handlers that never call `parseBody`. Only an Origin check covers every one, and every exported `POST`/`PUT`/`PATCH`/`DELETE` under `src/app/api` is already `export const X = withErrorHandler(…)`.
- **Cron.** Production runs the jobs in-process, so nothing legitimate calls `/api/cron/*` through nginx.
  - The documented manual curl in `DEPLOYMENT.md` targets the public hostname, so it breaks under an nginx deny and must move to `127.0.0.1:3000`.
  - The issue's nginx snippet would never reach the app: it has no `proxy_pass`. A plain `deny all` is the right shape.
- **Health is public on purpose,** by a recorded decision (the route docblock, the degradation-events spec, `DEPLOYMENT.md`). Its `status` field already rolls job health up, so per-job detail can move behind the cron secret and the monitors keep their signal.
- **Dev Postgres.** macOS resolves `localhost` to `::1` first, but Node's happy-eyeballs connect falls back to `127.0.0.1`, so an IPv4-only binding is enough.

## 2. Decisions

### 2.1 CSP for pages: per-request nonce

- **`src/proxy.ts` mints the nonce:** 16 bytes from `crypto.getRandomValues`, base64 — 128 bits — per request, for every page route.
  - It sets the full CSP on both the **request** headers (so Next stamps its scripts) and the **response**.
  - The matcher covers every path except `/api/*`, `/_next/static`, `/_next/image`, the favicon, the manifest, `sw.js` and the static icons.
  - The sign-in redirect keeps its own path list inside the function. That list is today's matcher, unchanged.
  - The proxy produces no error responses: it sets headers and, for the signed-out case, redirects. Nothing else.
- **Every page renders at request time.** The root layout calls `await connection()` (`next/server`). Without it, `/login`, `/verify` and the 404 page stay prerendered at build time, carry no nonce, and their scripts are blocked by the policy. Accepted: each is a small server render.
- **The policy:**
  - `script-src 'self' 'nonce-<n>' 'strict-dynamic'` (plus `'unsafe-eval'` in dev only);
  - `style-src 'self' 'unsafe-inline'`;
  - `worker-src 'self'` (service worker registration under `'strict-dynamic'`);
  - every other directive exactly as today.
- **The page CSP string is built in one module.** `src/lib/csp.ts` builds it from the nonce and the environment, and the existing `security-headers.test.ts` is moved onto it.

### 2.2 CSP for API responses: static

- `next.config.ts` keeps sending a `Content-Security-Policy`, but only for `/api/:path*`, and only `default-src 'none'; frame-ancestors 'none'`. A JSON body is not a document, so nothing in it may load or run if a browser is ever talked into rendering one.
- The page policy comes only from the proxy and the API policy only from `next.config.ts`. Their path sets do not overlap, so no response carries two CSP headers. Every other security header in `next.config.ts` is unchanged and still applies to every path.

### 2.3 CSRF: two layers beyond SameSite

- **Origin check in `withErrorHandler`.** Before calling the handler, for `POST`, `PUT`, `PATCH` and `DELETE`, the wrapper refuses with 403 and the registered code `CROSS_ORIGIN` when either:
  - an `Origin` header is present and its host (`host:port`) differs from the request's own `Host` header — `Origin: null` counts as foreign — or
  - `Sec-Fetch-Site` is `cross-site`.

  A request with neither header passes. Non-browser clients (curl for cron, Node fetch in the integration tests) send none, and a browser always sends one of them on a cross-site state-changing request.
- **Host only, not scheme.** nginx forwards `Host $host` on every `location` (`deploy/nginx.conf.example`) and terminates TLS, so Next sees `http` while the browser's `Origin` says `https`. Comparing hosts needs no environment variable and no fallback for a missing one.
- **The refusal is a response, not a throw.** It goes through `respondError` like every other registered refusal, so it is logged and shaped the same way, and the handler never runs.
- **`parseBody` requires `application/json`** (an exact media type match, with parameters such as `; charset=utf-8` allowed). Anything else gets 415 with the registered code `UNSUPPORTED_MEDIA_TYPE`. This closes the `text/plain` form path even where the Origin check might be bypassed, for example by a proxy that strips headers.
  - 415 is added to both status unions, `ApiErrorStatus` (`src/lib/api-error-codes.ts`) and `ErrorStatus` (`src/lib/api-utils.ts`).
- **Rejected: the `__Host-` cookie prefix.**
  - It defends against cookie injection from a hostile same-site subdomain, and this deployment serves none.
  - It requires `Secure` on every cookie in every environment, which today is set only in production and pinned by `origin-nonce.test.ts`. That would put development sign-in in Safari on `http://localhost` at risk.
  - The cookie name appears in four definitions and on 116 lines.
  - With the Origin check and the content-type check, SameSite=Lax is no longer the only layer, which was the issue's concern.

### 2.4 Cron secret

- **Constant-time compare, in one function.** `src/lib/cron-auth.ts` gains `hasCronSecret(request): boolean`, which compares SHA-256 digests of the presented and configured secrets with `crypto.timingSafeEqual`, so the lengths always match. A missing or empty configured secret answers `false`.
- **`requireCronAuth` is built on it** and keeps its two responses: 500 when `CRON_SECRET` is not configured, 401 otherwise.
- **nginx.** `deploy/nginx.conf.example` gets `location /api/cron/ { deny all; }`. Production jobs run in-process (`src/lib/scheduler.ts`), and a manual trigger goes to `http://127.0.0.1:3000` from the VPS, which `DEPLOYMENT.md` will say.
- **Testing limit.** No test can tell `timingSafeEqual` from `!==` by timing. The unit tests pin behaviour (right secret, wrong secret, wrong length, missing config). Reverting to `!==` is an equivalent mutant for those tests, and the review treats it so.

### 2.5 Health

- **Unauthenticated `GET /api/health`** answers `{ status, db }` only, with the same status codes as today.
- **A request for which `hasCronSecret` is true** gets today's full body, including per-job detail and the degradation count.
- **Never `requireCronAuth`.** Its 401/500 responses would turn a missing secret into a failed health check, and a server without `CRON_SECRET` into a 500 for the uptime monitor. Health asks a yes/no question and answers either way.

### 2.6 Dev Postgres

- `docker-compose.yml` publishes `127.0.0.1:5432:5432` only.
- Not verified by restarting the shared container: that would interrupt the `:3000` dev server and the other worktrees' tests. The binding takes effect on the next `docker compose up`.
- `docs/technical-architecture.md`'s compose example that claims to be production is corrected to match `docker-compose.prod.yml`, or replaced with a pointer to it.

## 3. Rejected

- **The `__Host-` prefix:** see §2.3.
- **The Origin check in the proxy:** see §1 — the proxy must not cover `/api/*`.
- **Comparing Origin against `NEXT_PUBLIC_APP_URL`:** needs a fallback rule for a missing variable, and the request's own `Host` already names the origin nginx served.
- **Rate-limiting failed cron auth:** the nginx deny removes the public path, and the in-process scheduler never authenticates over HTTP.
- **Restricting `/api/health` by IP in nginx:** the uptime monitor's IP isn't known to this repo, and splitting the body achieves the same thing without config drift.
- **Removing `'unsafe-inline'` from `style-src`:** the eleven `style={}` sites need it, and the risk it carries is not script execution.

## 4. Tests and the guards they must prove

| Guard | Test | Mutation that must turn it red |
|---|---|---|
| CSP header on every page | integration: GET `/`, `/login`, `/verify`, `/start`, `/schedule` (signed in), a teacher's public page, a 404 → each has `script-src` with a `'nonce-…'` and `'strict-dynamic'`, and no `'unsafe-inline'` in `script-src` | narrow the proxy matcher |
| nonce matches the scripts | integration (against CI's production build): on `/login` and a 404, the HTML's `<script nonce="…">` value equals the header's nonce, and the nonce differs between two requests | remove `await connection()` from the root layout; hard-code the nonce |
| `/start` still public | the existing `pwa.test.ts` case, plus a GET of `/start` without a session → 200 with the CSP | — |
| one CSP per response | integration: exactly one `Content-Security-Policy` header on a page and on an API response | add `/api/*` to the proxy matcher; widen the `next.config.ts` CSP source to all paths |
| API CSP | integration: an API response's CSP is exactly `default-src 'none'; frame-ancestors 'none'` | drop the `next.config.ts` entry |
| e2e still runs | the full Playwright suite in CI (production build) is the proof that `'strict-dynamic'` + nonce does not break hydration, the service worker, or passkeys | — |
| Origin check | unit on `withErrorHandler` + integration: POST with `Origin: https://evil.example` → 403 `CROSS_ORIGIN`; `Origin: null` → 403; `Sec-Fetch-Site: cross-site` → 403; no Origin → passes as today; the request's own host as Origin → passes; the handler is not called on a refusal | drop the check; compare scheme as well as host; treat `null` as absent |
| the 11 non-parseBody handlers are covered | integration on two of them (class cancel, payment unpaid) with a foreign Origin → 403 | — |
| early refusal survives | the existing `teacher-photo-api.test.ts` case "refuses a body with no Content-Length as no-photo, before the body is read" stays green | add `/api/*` to the proxy matcher (if the case stays green under that mutation, the plan adds a case that can see the buffering) |
| content type | unit/integration: `parseBody` with `text/plain` → 415 `UNSUPPORTED_MEDIA_TYPE`; `application/json; charset=utf-8` → accepted | drop the check |
| cron compare | unit on `hasCronSecret` and `requireCronAuth`: right, wrong, wrong-length, empty-config cases | invert the comparison |
| health split | integration: no secret → exactly `{ status, db }`; wrong secret → the same; with secret → today's full shape; no `CRON_SECRET` configured → still 200 `{ status, db }` | return the full body unconditionally; use `requireCronAuth` |
| codes registered | the existing `api-error-codes` registry test covers new codes, and 415 type-checks only because it is in the unions | — |

## 5. Documents that change with the code

Each states today's behaviour and is falsified by this branch:

- `DEPLOYMENT.md` — the health curl's expected body (line 36) and the monitor description (§ around line 129) show the summary/full split; the manual cron curl (line 103) moves to `http://127.0.0.1:3000`, with the nginx deny named as the reason; the `CRON_SECRET` row says it also unlocks health's detail.
- `deploy/nginx.conf.example` — the `/api/cron/` deny.
- `docs/technical-architecture.md` —
  - the unauthenticated-routes table: `health`'s row says the summary is public and the detail needs the cron secret (the census loop will now print `CRON_SECRET` for it);
  - the CSRF/cookie description near line 689 names the Origin and content-type layers;
  - Degradation events → Health (around line 1211): `degradations.open` is in the authenticated body;
  - the production compose example (§2.6).
- `docs/superpowers/specs/2026-10-02-degradation-events-design.md` — its "public" statements about the health body. A spec is a record, so this gets a dated note pointing here, not a rewrite.
- `src/app/api/health/route.ts` docblock and its "this endpoint is public" catch comment.
- Service comments that say a value is *publicly* visible on `/api/health` (`degradation-digest.ts`'s "the verdict `/api/health` already publishes" and any like it). Comments that only say health *reports* something stay true.
- `next.config.ts` — the CSP docblock that calls nonces "heavier than this app warrants".
- `docs/degradation-sites.md` — its `health/route.ts:<line>` rows, re-derived after the route changes.
- `README.md` line 41 and `AGENTS.md` line 6 still say `localhost:5432`, which stays true; no change.
