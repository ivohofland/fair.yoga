# Class Edit Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Spec:** `docs/superpowers/specs/2026-07-22-class-edit-screen-design.md`

### Task 1: Form + page + entry link
- `src/components/class/class-edit-form.tsx` (client): modeled on `TemplateForm` — form state prefilled from props; Input/Select fields per spec; economic block wrapped with `disabled={settingsLocked}` + explainer caption when locked; `PricingPreviewTable` from live economic values; submit `PUT /api/classes/${classId}`, `Saved` caption + `router.refresh()`, danger `<p>` for errors (read `json.error?.message ?? json.error`).
- `src/app/(teacher)/class/[id]/edit/page.tsx` (server): `requireTeacherSession`-style guard as the detail page; load class; not owner or not `draft|open` → `redirect(/class/[id])`; back link `← {classType}`; `type-title` h1 `Edit class`; render the form with initial values (`Number(...)` casts for decimals) and `settingsLocked`.
- Detail page actions block: `Edit class` link (`type-label text-teal`) inside the existing `draft || open` conditional, before `CancelClassButton`.

### Task 2: E2e + gates + PR
- `tests/e2e/class-edit.spec.ts`: fixtures — teacher + room + teacherRoom + draft class + locked open class (settingsLocked true, one registration w/ student) + teacher session. Tests: (1) draft: Edit class → change classType + targetRate → Save → Saved caption; detail shows both changes. (2) locked: economics disabled + explainer visible; description edit saves. (3) the edit URL of the locked-completed... use a cancelled class → redirected to detail.
- Full playwright + vitest (exit-gated) + tsc + lint; push; `gh pr create` (Closes #32).
