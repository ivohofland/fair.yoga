# Settings Courtesy Redirect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Spec:** `docs/superpowers/specs/2026-07-22-settings-courtesy-redirect-design.md`

### Task 1
- `src/middleware.ts`: forward the request with `x-pathname` set (`NextResponse.next({ request: { headers } })`) in the signed-in branch.
- `src/app/(teacher)/layout.tsx`: student-only branch reads `(await headers()).get('x-pathname')`; `/settings*` → `/account`, else `/bookings`.

### Task 2
- E2e in `account.spec.ts`: `goto('/settings')` with the student session → lands on `/account`.
- Gates; push; `gh pr create` (Closes #30).
