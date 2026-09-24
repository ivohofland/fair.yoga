# Inbox and /updates: reaching older notifications (#663)

## Problem

`/inbox` (teacher) and `/updates` (student) each render `findMany({ …, take: 50 })`
and stop. A recipient with more than 50 stored notifications cannot reach the
rest, while both pages end with "Messages are kept for a year." (#223).

## What the issue claimed, and what measured true

| Claim in #663 | Measured |
|---|---|
| "`GET /api/notifications` already paginates, but neither page uses it" | True that no page uses it. It has **no product consumer at all**: `grep -rn "api/notifications" src` finds the SSE stream and the `/[id]/read` route only, and the sole caller of the list route is `tests/integration/account-api.test.ts`. |
| "Order stays `createdAt desc, id desc` … the id tie-breaker the pages already use" | **The API has no tie-breaker**: `orderBy: { createdAt: 'desc' }`. With `skip`/`take`, rows sharing a `createdAt` (batch inserts, `createBulkNotifications`) can repeat or vanish across a page boundary. The pages have the tie-breaker; the API does not. |
| "Fetch the next page from `/api/notifications`" | The route returns **both profiles' rows** for a dual-role account, so `/inbox` fed from it would show student-side rows. It also returns raw rows with no `relatedClass`, and the student page's link targets (`studentNotificationHref`) need `relatedClass.status`, `calendarEntry.cancelledAt` and the teacher's `pageSlug`. |
| (implicit) offset pagination is adequate | `LiveUpdates` calls `router.refresh()` on every new notification, so rows are inserted at the head while a recipient is mid-scroll, and an offset (`skip`) shifts under them. |

So the API exists but cannot serve either page as it stands.

## Design

**Keyset pagination, one shared service that the API and both pages call.**

- **Order and cursor.** `createdAt desc, id desc`. A page's `nextCursor` is
  derived from its last row (`encodeNotificationCursor`); the next request
  filters `createdAt < c.createdAt OR (createdAt = c.createdAt AND id < c.id)`.
  `Notification.createdAt` is Prisma `DateTime` (`timestamp(3)`), so a
  millisecond epoch round-trips losslessly. No count query: the service reads
  `limit + 1` rows, and the extra one answers "is there more".
- **Service** `listNotificationPage` (`src/services/notifications.ts`) takes the
  recipient set (the shape the route already builds), a `limit` and an optional
  cursor, and returns `{ notifications, hrefById, nextCursor }`. It computes
  `hrefById` per row from the row's own `recipientType`
  (`teacherNotificationHref` / `studentNotificationHref`), so the pages and the
  API cannot disagree about where a row goes. It always selects the
  `relatedClass` shape the student href needs and strips it from the returned
  rows.
- **API.** `GET /api/notifications?before=<cursor>&limit=<1..100>&recipientType=<teacher|student>`.
  `recipientType` narrows a dual-role account to one hat (the list component
  always passes it); absent, the account's whole set is read, as today. `limit`
  keeps its garbage-degrades-to-default behaviour and now defaults to
  `NOTIFICATION_PAGE_SIZE`. A malformed `before` or `recipientType` is 400:
  degrading a bad cursor to page one would make a client loop. `page` and
  `total` go, since nothing reads them and a total needs a count neither page wants.
- **Client.** `NotificationList` gains `paging?: { audience; nextCursor }`. With
  a non-null cursor it renders a **"Show older messages"** button between the
  rows and the retention note; it fetches the next page, appends it, and the
  button disappears when `nextCursor` is null. Not infinite scroll (calm utility).
  - After the first click the list keeps its own copy of everything shown, and
    each render displays the union by id of the page's `notifications` prop and
    that copy, newest first, the prop's version winning on a collision. That
    keeps a `router.refresh()` between clicks from dropping the row that slid
    out of the refreshed first page (a gap) or repeating one (a duplicate).
  - Read state is unchanged: `readState[id] ?? notification.isRead`, so a row
    loaded later shows its own `isRead` until the user marks it.
  - A failed fetch shows a `role="alert"` line and leaves the button, so a retry
    resumes from the same cursor. Clicks are ignored while a fetch is in flight.
  - After a page loads, focus moves to the first new row, so the button
    disappearing at the end of the list does not drop keyboard focus to `body`.
- **Pages.** Both call the service with `NOTIFICATION_PAGE_SIZE` (50, unchanged)
  and pass `hrefById` and `paging`. `/updates` loses its inline query.

**Decided without asking** (the session ran unattended): keyset over offset, and
the button over changing the caption. The caption is true either way; the
alternative would have been to reword it and leave the rows unreachable.

## Not changing

- **No index.** The list query filters on `(recipientType, recipientId)`, the
  prefix of the existing `(recipientType, recipientId, isRead)` index, and sorts
  within one recipient's rows. An index on `createdAt` would be maintained on
  every insert into the app's highest-write table (`docs/data-model.md`,
  Notification section), and a recipient's row count is bounded by the
  retention sweep.
- **The `/bookings` strip** (`updates-strip.tsx`) previews unread rows and is unaffected.
- **Retention copy** stays; it is now true of what the recipient can reach.

## Acceptance (from the issue)

1. A recipient with more than one page can reach every stored row from either page.
2. `createdAt desc, id desc` across pages, no duplicates or gaps for rows created in the same instant: an integration test over the API boundary, including a tie group straddling it.
3. Read state works for rows loaded later: component test.
4. Component test for the control; integration test for the boundary.
