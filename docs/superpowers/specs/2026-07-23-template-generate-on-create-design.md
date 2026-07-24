# Recurring templates: instances exist the moment the template does

> **Superseded by [2026-07-23-class-generation-hardening-design](./2026-07-23-class-generation-hardening-design.md)** — template creation is now atomic (generate inside the create transaction; failure rolls back and 500s) rather than swallow-and-heal-via-cron.

**Date:** 2026-07-23
**Status:** Approved (issue #44; approach A chosen by Ivo)

## Problem

`POST /api/class-templates` creates the template row and nothing else, so
a teacher who sets up a weekly class sees an empty schedule until the
class-generation cron next runs. The same gap exists on re-activation:
`PATCH` toggling a paused template back to active creates nothing. The
manual `POST /api/class-templates/generate` endpoint was built to fill
this hole but no front-end ever called it.

## Decisions

- **Generation happens in the routes, synchronously.** After the create
  in `POST /api/class-templates` and after a pause→active toggle in
  `PATCH /api/class-templates/[id]`, call
  `generateClassInstances(prisma, undefined, session.teacherId)`. The
  service is idempotent (per-date check plus the
  `@@unique([templateId, date])` backstop) and teacher-scoped, and the
  work is at most four inserts — synchronous is honest and cheap on the
  single-process VPS.
- **Paths that do NOT generate:** archive (forces `isActive: false`),
  un-archive (leaves the template paused — activation is the single
  "goes live" moment), active→pause, and `PUT` (edit already syncs
  still-mutable instances; the cron owns window drift).
- **Response shapes are unchanged** (`201` template on POST, template on
  PATCH). The front-end needs no changes: the teacher lands on the
  schedule and the instances are simply there.
- **Generation failure does not fail the request.** The cron guarantees
  eventual generation, so the in-route call is an acceleration of an
  already-guaranteed process, not the source of truth. If it throws, log
  it and still return success — a 500 here would leave the teacher
  retrying a create that already succeeded (duplicate templates), which
  is worse than a schedule that heals on the next cron tick.
  **Accepted edge** (review adjudication): the cron never creates an
  occurrence whose start already passed, so if generation fails during a
  re-activation moments before the template's next class, that single
  occurrence is lost rather than healed. The conjunction — transient
  failure AND an imminent occurrence AND the hourly sweep missing the
  window — is rare enough that retry machinery isn't warranted.
- **Delete `/api/class-templates/generate`.** With generation wired into
  the lifecycle routes it has no caller and no reason to exist.

## Testing

- Integration (HTTP level, chips at #53): `POST /api/class-templates`
  → template created AND four instances exist immediately; toggling a
  paused template active after removing an instance → the missing
  instance is regenerated; instance dates respect the template's
  `dayOfWeek` and the teacher's timezone (assert via the service's
  existing semantics, not re-derived math).
- E2e: the recurring-template UI flow asserts the schedule shows the
  generated instance(s) immediately after the template is saved — no
  cron involved in the test.
- The deleted route needs no migration of tests (it had none).
