# Non-Goals

Things this project has deliberately decided **not** to build. A non-goal is
different from *deferred* work: deferred is "later, not now"; a non-goal is
"not for this project, given its constraints" — no phase will pick it up.

This list exists so a promise in the product docs and the actual build stop
drifting apart — the class of gap the API↔UI audit keeps surfacing. When any
doc references a non-goal feature, it should link here rather than imply the
feature is forthcoming.

| Feature | Decided | Why it's a non-goal | What exists instead |
|---|---|---|---|
| **Custom domain for teacher pages** (teacher-screens 4.2) | 2026-07-23 | The cost isn't the CRUD — it's *perpetual per-teacher TLS automation* (Let's Encrypt issuance + nginx reload per domain) running forever on a single 2 GB VPS: ongoing ops plus an attack surface. That doesn't fit a free, volunteer, single-box project. | Every teacher already has a working public page at `app.com/{pageSlug}`; a custom domain would be pure vanity on top of it. The `Teacher.customDomain` field stays dormant (harmless, GDPR-handled) — no UI or logic is built. |

## Related

- **Deferred (later, not never)** — tracked inline in the relevant docs with a "(deferred)" / "(not yet built)" marker (e.g. Level 2 payments, GDPR teacher-export, room-merge admin tooling). If that scatter becomes hard to audit, promote it to a companion `deferred.md` registry.
