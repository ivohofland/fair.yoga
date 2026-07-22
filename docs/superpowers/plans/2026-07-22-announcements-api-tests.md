# Announcements API Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin `POST /api/announcements` recipient selection, mute filter, ownership, and empty-recipients behavior (issue #25).

**Spec:** `docs/superpowers/specs/2026-07-22-announcements-api-tests-design.md`

### Task 1: The suite

Create `tests/integration/announcements-api.test.ts` per the spec's fixture graph and five tests, following the `teachers-api.test.ts` conventions (hashed-token session, unique suffix, guarded cleanup). Registration rows need `tierAtBooking`; classes need the full required column set (copy the `teachers-api`/`booking.spec` class shape). Assert notification counts scoped by `recipientId in [S1,S2,S3]` and `type: 'announcement'` so parallel dev-DB noise can't flake the counts; test 2's assertion counts rows created *after* a captured timestamp guard (`createdAt: { gt: before }`) for the same reason.

### Task 2: Verify + PR

Run the file (all five green against live behavior — any red is a found bug to report, not to paper over), full gates, push, `gh pr create` (Closes #25).
