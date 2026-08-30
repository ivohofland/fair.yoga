# Form Validation Accessibility & Clear-on-Change Conventions

This document establishes the house standards for form validation error presentation and accessibility across fair.yoga, as resolved in Issue #313.

---

## Core Principles

1. **Inaudible Refusal Prevention (`role="alert"`)**:
   - Validation refusals that prevent form submission without full-page navigation or button-label flips MUST be announced to assistive technologies (screen readers).
   - Any validation error message rendered in a top-level form banner or next to an action control MUST include `role="alert"`.
   - Per-field errors rendered by `<Input />` automatically carry `role="alert"`, `id="${inputId}-error"`, and are linked via `aria-describedby` and `aria-invalid` on the underlying `<input />`.

2. **Immediate Complaint Clearing (Clear-on-Change)**:
   - When a validation error banner is displayed (e.g. "Class type is required."), editing *any* relevant input field MUST clear the error banner immediately (`setError('')`).
   - A form must never display an error message complaining about a missing or invalid value while the teacher is actively typing a valid value into that field.

3. **Per-Field Feedback**:
   - When using `<Input />`, pass field-specific validation errors via the `error` prop whenever per-field errors are tracked.
   - For generic form banners at the bottom of forms (e.g. create/edit forms), render `{error && <p role="alert" className="text-sm text-danger">{error}</p>}`.

---

## Form Validation Census

| Form / Component | Location | Validation Type | Error Presentation | Clear-on-Change Mechanism |
|---|---|---|---|---|
| **Studio Class Create** | `src/app/(teacher)/studio-class/new/page.tsx` | Client pre-check (`handleSubmit`) | `<p role="alert" className="text-sm text-danger">` | `updateField()` wrapper calling `setError('')` on every input |
| **Studio Template Form** | `src/components/settings/studio-template-form.tsx` | Client pre-check & API error | `<p role="alert" className="text-sm text-danger">` | `update()` calling `setError('')` & `setSuccess('')` |
| **Studio Class Edit** | `src/components/studio-class/studio-class-edit-form.tsx` | Per-field (`validate`) & API banner | `<Input error={...} />` + `<span role="alert">` | `set()` calling `setError('')` & clearing `fieldErrors[key]` |
| **Class Template Form** | `src/components/settings/template-form.tsx` | API error banner | `<p role="alert" className="text-sm text-danger">` | `update()` & `handleRoomChange()` calling `setError('')` |
| **Class Edit Form** | `src/components/class/class-edit-form.tsx` | Client pre-check & API error | `<p role="alert" className="text-sm text-danger">` | `set()` calling `setError('')` |
| **Class Create Wizard** | `src/app/(teacher)/class/new/page.tsx` | Multi-step client validation & API banner | `<Input error={...} />` + `<p role="alert">` | `updateField()` & `handleRoomChange()` clearing `submitError` and `errors[key]` |
| **Edit Room Form** | `src/components/settings/edit-room-form.tsx` | Client pre-check & API error | `<p role="alert" className="text-sm text-danger">` | `clearStatus()` on input changes |
| **Edit Teacher Room Form** | `src/components/settings/edit-teacher-room-form.tsx` | Client pre-check & API error | `<p role="alert" className="text-sm text-danger">` | `clearStatus()` on input changes |
| **Teacher Profile Form** | `src/components/settings/profile-form.tsx` | Client pre-check & API error | `<p role="alert" className="text-sm text-danger">` | `update()` calling `setError('')` |
| **Room Creation Step** | `src/components/settings/room-create-step.tsx` | API error banner | `<p role="alert" className="text-sm text-danger">` | `set()`, `onStreetChange()`, `onPostcodeChange()` clearing `createError` |
| **Room Search Step** | `src/components/settings/room-search-step.tsx` | API error banner | `<p role="alert" className="text-sm text-danger">` | `onPostcodeChange()` & `onStreetChange()` clearing `searchError` |
| **Room Settings Step** | `src/components/settings/room-settings-step.tsx` | API error banner | `<p role="alert" className="text-sm text-danger">` | Input `onChange` handlers clearing `settingsError` |

---

## Action / Dialog Buttons Census

Every destructive action, transition button, or dialog refusal renders with `role="alert"`:

- `src/components/settings/archive-studio-template-button.tsx`
- `src/components/settings/toggle-studio-template-button.tsx`
- `src/components/settings/archive-template-button.tsx`
- `src/components/settings/toggle-template-button.tsx`
- `src/components/settings/archive-room-button.tsx`
- `src/components/settings/delete-room-button.tsx`
- `src/components/settings/unlink-room-button.tsx`
- `src/components/settings/share-room-button.tsx`
- `src/components/studio-class/cancel-studio-class-button.tsx`
- `src/components/studio-class/delete-studio-class-button.tsx`
- `src/components/studio-class/restore-studio-class-button.tsx`
- `src/components/class/cancel-class-button.tsx`
- `src/components/class/complete-class-button.tsx`
- `src/components/class/publish-class-button.tsx`
- `src/components/class/add-walk-in.tsx`
- `src/components/class/send-announcement.tsx`
- `src/components/class/attendance-list.tsx`
- `src/components/class/payment-checklist.tsx`
- `src/components/class/outstanding-payment-row.tsx`
- `src/components/account/data-and-deletion.tsx`
- `src/components/account/add-passkey.tsx`
- `src/components/student/cancel-booking-button.tsx`
- `src/components/booking/booking-flow.tsx`
- `src/components/booking/join-as-student.tsx`
- `src/components/booking/booking-sign-in.tsx`
- `src/components/booking/passkey-sign-in.tsx`
- `src/app/(public)/login/page.tsx`
