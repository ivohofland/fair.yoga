# Class edit screen

**Date:** 2026-07-22
**Status:** Approved (issue #32; autonomous run — decisions recorded here)

## Problem

`PUT /api/classes/[id]` has existed all along — race-safe economic lock
included — but no UI reaches it. Drafts offer only Publish and Cancel.

## Decisions

- **Entry:** an `Edit class` link in the class detail page's bottom
  actions block, under the existing `draft || open` guard — exactly the
  edit-eligible condition. (The header action slot stays with
  Publish/Complete.)
- **Shape:** a dedicated page `/class/[id]/edit` (server component
  prefill → client `ClassEditForm`), following the recurring-template
  edit pattern (`settings/recurring/[id]` → `TemplateForm`). The page
  guards: not the owner or not `draft|open` → redirect to the class.
- **Fields**, mirroring `updateClassSchema` exactly:
  - Always editable: `classType`, `description`, `date`, `startTime`,
    `durationMinutes`.
  - Economic (`roomCost`, `minRate`, `targetRate`, `minStudents`,
    `maxStudents`): enabled while `settingsLocked` is false; disabled
    with an explainer once locked — "Locked since the first
    registration — the economics can't change under students."
  - Room is not part of the update schema → not editable here
    (cancel-and-recreate remains the room-change path; out of scope).
- **Preview:** `PricingPreviewTable` fed live from the five economic
  values, as the create wizard and TemplateForm already do.
- **Submit:** `PUT /api/classes/[id]`; stay on the page with a `Saved`
  caption (TemplateForm pattern); errors — including the 409 when a
  registration lands mid-edit — surface the API's message in the
  standard danger `<p>`; never silent.

## Known behavior, recorded

The API allows `date`/`startTime` changes on locked classes (they're
non-economic). The form exposes what the API allows; notifying
registered students about a moved class is existing-API territory and
out of scope — flagged for a possible follow-up issue.

## Testing

- New e2e `class-edit.spec.ts`: edit a draft (type + a rate) → detail
  reflects both; a locked open class shows disabled economics with the
  explainer, and a description edit still saves; non-owner/URL-guessing
  redirects covered by the page guard (one assertion).
- Full suites, `tsc`, `eslint`.
