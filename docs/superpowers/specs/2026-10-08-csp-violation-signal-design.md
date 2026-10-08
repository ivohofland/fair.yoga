# CSP violations surface somewhere (#793)

#792 (#770) moved pages to a per-request nonce CSP with `'strict-dynamic'`. A
page whose HTML and header nonces disagree renders but never hydrates, and
nothing reports it. This issue takes both options it proposes: an e2e guard
that fails CI, and a report endpoint that gives production a log line.

## 1. Premise, measured on `origin/main` at `de352d49`

| Issue claim | Verdict | Measurement |
|---|---|---|
| Nothing in `src/` opts into static rendering or adds an inline script | holds | `grep -rn "force-static\|generateStaticParams\|dangerouslySetInnerHTML\|<Script" src` is empty |
| The policy has no `report-uri` / `report-to` | holds | `src/lib/csp.ts` |
| `fixtures.ts` captures but never fails | holds | its docblock says so deliberately |
| CI's e2e runs a production build | holds | `ci.yml` `test-e2e`: `pnpm run build`, then `node .next-build/standalone/server.js` |
| An auto fixture "catches regressions on every page the suite visits" | **incomplete** | all 21 `*.spec.ts` import `test` from `./fixtures`, but 3 (`account`, `booking`, `magic-link-handoff`) open their own `browser.newContext()` — 7 call sites (1 + 1 + 5). A listener armed on the `page` fixture never sees those pages. |
| Accept `application/csp-report` **and** `application/reports+json`; add `report-to` **and** `report-uri` | **wrong for Chromium** | against a throwaway server, headless Chromium 149 on `http://localhost` delivered a `report-uri` report within 3 s, and **no** `report-to` report within 75 s. Chromium ignores `report-uri` whenever `report-to` is present, so adding `report-to` would replace the one delivery path we could observe with one we could not. |
| The report is a new unauthenticated write | holds, and it passes the Origin check | the measured `report-uri` POST carried `Origin: http://localhost:4799` (equal to `Host`) and `Sec-Fetch-Site: same-origin`, so `crossOriginRefusal` returns null for it unchanged |
| Must not fire on dev-only noise | measured: there is none to filter | the dev server (`next dev`, worktree) produced no violation on `/`, `/login`, `/signup`, `/start` or a 404 |

The measured report body:

```json
{"csp-report":{"document-uri":"http://localhost:4799/some/path?q=1","violated-directive":"script-src-elem","effective-directive":"script-src-elem","disposition":"enforce","blocked-uri":"inline","status-code":200, "...": "..."}}
```

`blocked-uri` is a keyword (`inline`, `eval`) as often as a URL, and
`document-uri` carries the query string, where this app keeps tokens
(`/verify?token=`). No page path segment is a secret: the dynamic segments are
slugs and cuids (`find src/app -name page.tsx | grep "\["`).

## 2. Design

### 2.1 e2e: a violation fails the test

- `tests/e2e/fixtures.ts` gains a CSP watcher, armed on a `BrowserContext`:
  - an init script that adds a `securitypolicyviolation` listener on `document`
    and hands `effectiveDirective`, `blockedURI` and the document path to a
    context binding;
  - a `console` listener on the context for messages containing
    `Content Security Policy` — the channel a violation outside a document
    listener's reach (a worker) would use.
- An auto fixture arms the default context, and arms every context the test
  opens through `browser.newContext()` (and `browser.newPage()`, which goes
  through it) by wrapping that method for the test's duration. Wrapping rather
  than a helper every spec must remember: a guard each spec has to opt into is
  missing from the spec that needed it — the reason `browserLogs` is `auto`.
- At teardown, any recorded violation fails the test with the list.
- The `browserLogs` docblock keeps its reason for not failing on console
  errors in general; CSP violations are the narrow exception, and it says why.
- Pinned by an e2e spec that triggers a violation on a real app page in both
  kinds of context and is marked `test.fail()`, plus a mechanism case asserting
  the recorded entry. The acceptance proof — a nonce mismatch in
  `src/proxy.ts`, suite goes red — is a recorded mutation, not a committed test.

### 2.2 Production: a report endpoint

- `buildPageCsp` appends `report-uri /api/csp-report`. Not `report-to` (§1).
- `POST /api/csp-report`, wrapped in `withErrorHandler` (the write-handler
  census requires it; the Origin check passes a real report, §1):
  1. IP rate limit, new prefix `csp-report:ip`, 60 per minute — one broken
     page load can produce a report per blocked chunk. Over the limit: 429,
     nothing logged.
  2. `Content-Type` must be `application/csp-report`, else 415
     `UNSUPPORTED_MEDIA_TYPE`. Read with `request.text()`, not `parseBody`.
  3. `Content-Length` required and at most 8 KiB, else 400 — a measured report
     is under 400 bytes; refusing a missing header refuses a chunked body.
  4. Body parsed and summarised by a pure function in `src/lib/csp-report.ts`:
     `directive` (lowercase letters and `-`, ≤ 64), `blockedUri` (scheme and
     host for a URL, the keyword for a keyword, else `other`), `documentPath`
     (pathname only, ≤ 256), `disposition`. Malformed → 400.
  5. One `log.warn` with that summary; answer 204.
- No global log throttle beyond the per-IP limit: a distributed sender can fill
  logs through this route as through any other; accepted, and stated in the doc.

### 2.3 Docs

- `docs/technical-architecture.md` gains a **Content Security Policy** section:
  where violations surface (e2e fixture in CI, `csp violation` warn in
  production), why `report-uri` and not `report-to`.
- The unauthenticated-routes census is re-derived: one more route, one more
  rate-limited unguarded route, the "neither" set unchanged.

## 3. Rejected

- **`report-to` beside `report-uri`.** §1: Chromium would drop the path we can test.
- **A census test forcing specs to arm their own contexts.** Wrapping
  `browser.newContext` arms them without anyone remembering.
- **Failing on every console error.** `fixtures.ts`'s own reasoning stands; the
  CSP match is narrow and has no measured noise.
- **Logging the full `document-uri` / `blocked-uri`.** Query strings carry tokens.

## 4. Guards and how each is broken

| Guard | Broken by | Expected |
|---|---|---|
| fixture fails on a violation, default context | delete the teardown assertion | the `test.fail()` spec passes unexpectedly → red |
| fixture covers `browser.newContext()` | drop the wrap | the newContext `test.fail()` case → red |
| suite catches a real broken page | `proxy.ts`: request-header nonce ≠ response nonce | specs visiting pages go red listing `script-src-elem` violations |
| report-uri present | drop it from `buildPageCsp` | `csp.test.ts` + integration header pin red |
| route content-type / size / rate limit | remove each check | its integration case red |
| summary strips query and URL path | return raw values | `csp-report.test.ts` red |
