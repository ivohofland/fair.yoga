# Teacher profile photo — design (#46)

A teacher uploads a photo on `/settings/profile`. Students meet it on the
teacher's public page (`/[slug]`); the teacher sees it in the Schedule header.
With no photo, both places show an initials avatar. Erasure deletes the bytes;
the data export carries them.

## Premise check

Measured on `origin/main` at `861e7c09`, against the issue body.

| Issue says | Measured |
|---|---|
| `Teacher.photoUrl` and `updateTeacherSchema.photoUrl` exist; nothing uploads, stores or renders a photo | **Holds.** `prisma/schema.prisma` (`photoUrl String?`), `src/lib/schemas.ts` (`photoUrl: z.string().url().nullable().optional()`). `grep -rnE "photoUrl\|[Aa]vatar" src prisma tests` finds only those two, the init migration, erasure writing `photoUrl: null` (`src/services/gdpr.ts`), and three lines in `src/lib/schemas.test.ts`. |
| The schedule index is `src/app/(teacher)/page.tsx` | **Moved.** It is `src/app/(teacher)/schedule/page.tsx`. The public page path (`src/app/(public)/[slug]/page.tsx`) holds. |
| No avatar pattern in the components or design brief | **Holds.** `docs/design-brief.md` and `docs/design_handoff_fairyoga/` mention photos only to forbid *stock* photos and illustrations on functional screens — decoration, not a person's own content. |
| — (not in the issue) | `src/lib/schemas.test.ts` registers `updateTeacherSchema: ['photoUrl']` as a KNOWN GAP "Blocked on #46", and `docs/superpowers/specs/2026-08-01-pin-remaining-form-field-lists-design.md` (#136) left `profile-form.tsx` unpinned because a forward pin fails naming `photoUrl`. Both clear when `photoUrl` leaves the schema. |
| — | **nginx's default `client_max_body_size` is 1 MB** and `deploy/nginx.conf.example` does not raise it. A phone photo is typically 2–6 MB: without a change, an upload dies at nginx with an HTML 413 the app never sees. |
| — | Many `Teacher` reads load the whole row — `GET /api/teachers/[id]` returns it verbatim, `/settings/profile` reads it without a `select`. Bytes on `Teacher` would ride along on all of them, so they get their own table. |
| — | `sharp` 0.35.4 is already in `pnpm-lock.yaml` (Next's optional dependency), including the `linuxmusl` binaries the Alpine runtime image needs. It has no install script, so `allowBuilds` in `pnpm-workspace.yaml` is unaffected. |
| — | `src/proxy.ts`'s matcher covers no `/api/*` path, so Next's proxy body buffering (`proxyClientMaxBodySize`, 10 MB default) does not apply to the upload route. |

## Decisions (agreed at the brainstorming gate)

1. **Upload raw, process on the server.** nginx gets `client_max_body_size 10m`
   on the photo route only; the app refuses above 8 MB. The app's limit sits
   below nginx's so an oversize upload is always answered by the app, in JSON.
   `sharp` is the one authoritative processing path — no client-side canvas.
2. **Addressed by photo id.** `GET /api/teacher-photos/[photoId]`, where the id
   is regenerated on every upload and so *is* the version stamp. Immutable
   caching; a replaced or erased photo's old URL answers 404. The public page
   never carries the teacher's UUID.
3. **Folded in:** the `profile-form.tsx` field pins #136 deferred to this issue;
   the photo in the teacher data export; a per-teacher upload rate limit.
4. **Avatar:** circle; 72px on the public page, 40px on the Schedule header.
5. **An upload racing erasure answers 404 "Teacher not found"** — no new error
   code for a window a real user can barely reach (erasure also ends their
   sessions).

## Data model

One migration:

```prisma
model TeacherPhoto {
  id        String   @id @default(uuid())
  teacherId String   @unique
  bytes     Bytes
  createdAt DateTime @default(now())

  teacher Teacher @relation(fields: [teacherId], references: [id], onDelete: Cascade)
}
```

The relation carries `onDelete: Cascade`: tests hard-delete `Teacher` rows,
while production erasure only anonymises the row (never deletes it) and
removes the photo itself, in `deleteTeacherAccount`'s own transaction.

`Teacher` gains `photo TeacherPhoto?` and loses `photoUrl`. There is no
`contentType` column: the stored bytes are always WebP.

A replace is an `upsert` on `teacherId` whose `update` writes
`{ id: randomUUID(), bytes }`. Nothing references `TeacherPhoto.id`, so a new
primary key per upload is free, and two concurrent uploads resolve last-write-wins
through `ON CONFLICT` instead of racing a delete-then-create into a P2002.

## Image processing — `src/services/teacher-photo.ts`

Framework-agnostic: bytes in, WebP bytes out, or a typed refusal.

- `sharp(input, { limitInputPixels: 50_000_000 })` — refuses a decompression
  bomb before it allocates.
- Accepts JPEG, PNG and WebP only, checked against sharp's own detected
  `format` from `metadata()`, never the client's `Content-Type` or filename.
  SVG, GIF, HEIC and anything undecodable are refused. (Prebuilt sharp cannot
  decode HEIC; iOS Safari converts a HEIC to JPEG when the file input's
  `accept` omits it.)
- `.rotate()` applies the EXIF orientation, `.resize(400, 400, { fit: 'cover' })`
  crops centre-square, `.webp({ quality: 80 })` encodes. sharp writes no input
  metadata unless asked, so EXIF — including GPS, which on a phone photo is
  often the teacher's home — does not survive. That stripping is the privacy
  reason sharp is on the server path at all.
- 400px covers the 72px avatar at 3× device pixel ratio with room to spare.

## Routes

### `POST /api/teachers/[id]/photo` — multipart, field `photo`

In order:

1. `requireTeacher`; `session.teacherId !== id` → 403.
2. Per-teacher rate limit via `checkRateLimit` (10 per 15 minutes) → 429.
3. `Content-Length` absent or above 8 MB → 400, before the body is read.
   After `formData()`, the file's actual size is checked again — `fetch`
   computes `Content-Length` itself, so this post-parse `file.size` check is
   defence no HTTP test can reach.
4. Process (above). Refusal → 400 with a message naming the accepted formats.
5. One transaction:
   `SELECT "deletedAt" FROM "Teacher" WHERE id = $1 FOR SHARE` — absent or
   erased → 404 "Teacher not found". Then the `upsert`.
6. `respondOk({ photoId })`.

400 and 429 carry no code: codes are required only on 409s
(`docs/technical-architecture.md`, Error responses).

### `DELETE /api/teachers/[id]/photo`

Owner-only (403 otherwise). A teacher with no photo gets `respondUnchanged` —
the goal already holds, and the check sits after ownership, so it is not an
oracle for another teacher's state. Otherwise `deleteMany` by `teacherId`
and `respondOk`.

### `GET /api/teacher-photos/[photoId]`

Public, because the public page is. Looks the row up joined to a teacher with
`deletedAt IS NULL`; unknown or erased → 404. Answers the bytes with
`Content-Type: image/webp`, `Cache-Control: public, max-age=31536000, immutable`
and `X-Content-Type-Options: nosniff` (already global, via `next.config.ts`).

## Erasure — and the race it closes

`deleteTeacherAccount`'s closing transaction adds
`tx.teacherPhoto.deleteMany({ where: { teacherId } })` **after** its
`tx.teacher.updateMany`. The order is what makes erasure complete against an
upload in flight — sharp can take hundreds of milliseconds, a wide window:

- **Upload locks first.** The upload holds `Teacher` `FOR SHARE`; erasure's
  `UPDATE` (`FOR NO KEY UPDATE`) waits for it to commit. Erasure's `DELETE`,
  a later statement under READ COMMITTED, takes a fresh snapshot and sees —
  and removes — the row the upload just wrote.
- **Erasure locks first.** The upload's `FOR SHARE` waits for erasure to commit,
  then reads `deletedAt` set and refuses with 404.

With the `DELETE` placed *before* the `UPDATE`, the first ordering leaks: the
delete finds nothing, erasure then waits on the upload, and the upload's row
survives erasure. That is the mutation the race test must catch.

`FOR SHARE`, not `FOR KEY SHARE`: `FOR KEY SHARE` does not conflict with
`FOR NO KEY UPDATE`, so it would not wait for erasure at all. (The FK check on
the upsert already takes `FOR KEY SHARE` on the teacher, for exactly that
reason useless as a gate.)

Both transactions take `Teacher` before `TeacherPhoto`, and the upload takes
nothing else, so no cycle is possible. `docs/lock-order.md` gets an entry for
the new node covering both modes, the erasure's placement, and the upsert's
own row lock.

## Export

`exportTeacherData`'s `profile` gains
`photo: { contentType: 'image/webp', base64: string } | null`. The photo is
personal data the teacher supplied; an export omitting it is incomplete.

## Schema and pin clean-up

- `photoUrl` leaves `updateTeacherSchema`, `SERVER_OWNED_FIELDS`, the
  `EXPECTED` register and the curated-list assertion in `schemas.test.ts`, and
  erasure's `updateMany`. Removing the column first makes
  `_serverOwnedNamesExist` fail naming `photoUrl` — recorded as the proof that
  pin bites.
- `profile-form.tsx` gains the two `NoneOf<Exclude<keyof …>>` pins against
  `updateTeacherSchema` that `class-edit-form.tsx` and `template-form.tsx`
  already carry, each broken once and restored with its error text recorded.

## UI

### `<Avatar>` — `src/components/ui/avatar.tsx`

Server-safe (no `'use client'`). Props:
`{ firstName: string; lastName: string; photoId: string | null; size: 40 | 72 }`
— a literal union, so a new size is a deliberate edit.

- With a photo: `next/image` with `unoptimized` (the bytes are already sized;
  Next's optimizer would re-process them, and a plain `<img>` trips
  `@next/next/no-img-element`), fixed width and height, `rounded-pill`,
  `object-cover`. `alt=""`: every placement sits beside the teacher's name, and
  a screen reader would otherwise read it twice.
- Without: the first letters of first and last name, uppercased, Georgia bold,
  teal on `teal-tint`, `aria-hidden`.
- No ring, border, shadow or hover step. Documented in `docs/design-brief.md`.

### Placements

- **Public `/[slug]`:** 72px avatar to the left of the name and bio block. The
  existing `select` gains `photo: { select: { id: true } }`.
- **`/schedule`:** 40px avatar left of the "Schedule" title, linking to
  `/settings/profile` with accessible name "Profile".
- **`/settings/profile`:** `ProfilePhotoField` (client) above `ProfileForm`,
  saving on its own because it has its own endpoint. Shows the 72px avatar, an
  "Upload photo" / "Replace photo" button opening a hidden
  `<input type="file" accept="image/jpeg,image/png,image/webp">`, and a quiet
  "Remove" text button when a photo exists. A file above 8 MB is refused in the
  browser before any request. "Uploading…" disables both buttons. Errors render
  in danger text with `role="alert"`; a non-JSON response (an nginx HTML page)
  falls back to a generic message. Success calls `router.refresh()`. No confirm
  on Remove — re-uploading undoes it.

`public-page.png` and `schedule.png` in `tests/e2e/visual.spec.ts` change for
real and are regenerated, not attested.

## Deployment

`deploy/nginx.conf.example` gains a regex `location` for
`^/api/teachers/[^/]+/photo$` with `client_max_body_size 10m` and the same
proxy headers as `/`. `DEPLOYMENT.md` names it. The runtime image must carry
sharp's `linuxmusl` binary: verified by a `docker build` and an upload against
the built image, since a worktree resolves `node_modules` through the main
checkout and cannot prove what the standalone trace includes.

## Testing

- **Unit** (`teacher-photo.ts`), fixtures generated by sharp at test time:
  output is 400×400 WebP; **an input carrying EXIF GPS comes out with none**;
  EXIF orientation is applied; SVG, GIF and random bytes are refused; an image
  above the pixel limit is refused.
- **Integration:** 401 and 403; oversize by header; non-image;
  a replace issues a new id and the old URL 404s; DELETE twice answers
  `unchanged`; GET headers; GET for an erased teacher 404s; erasure deletes the
  bytes; the export carries the photo; the rate limit bites.
- **Race:** a second connection holds the `Teacher` row lock, one test per
  ordering. The erasure ordering is mutation-tested by moving the `deleteMany`
  above the `updateMany`; the upload gate by weakening `FOR SHARE` to
  `FOR KEY SHARE`.
- **Component:** `Avatar` fallback and image; `ProfilePhotoField` states and the
  client-side size refusal.
- **e2e:** upload on `/settings/profile`, see it on the public page.

## Out of scope

- Avatars in the students directory — rows are text-first per the brief.
- Student photos.
- Cropping UI: centre-cover is the only crop.
