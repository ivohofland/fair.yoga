# Inbox "Show older messages" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recipient with more than one page of notifications can reach every stored row from `/inbox` or `/updates`, through a "Show older messages" button.

**Architecture:** One keyset-paginated service (`listNotificationPage`) ordered `createdAt desc, id desc`, called by `GET /api/notifications` and by both pages. `NotificationList` fetches further pages from the API and keeps a union-by-id copy of everything shown.

**Tech Stack:** Next.js 16 App Router, Prisma, vitest (unit / components / integration projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-inbox-show-older-design.md`

## Global Constraints

- TypeScript `strict: true`; no `any`, no `as any`.
- Test-first: each task writes its failing tests, sees them fail, then implements.
- Services are framework-agnostic: `src/services/` imports no `next/*`.
- `src/lib/notification-paging.ts` must stay free of server-only imports (it is imported by a `'use client'` component). Never import `@/lib/log` or `@/lib/db` into it.
- Page size is `NOTIFICATION_PAGE_SIZE = 50`; API max is `NOTIFICATION_MAX_PAGE_SIZE = 100`.
- Button copy is exactly `Show older messages`; failure copy is exactly `Couldn't load older messages.`; the loading label is `Loading…`.
- No motion, no shadows, no new icons. Failure text uses the `text-danger` token; the button reuses `type-label text-teal`.
- Comments: default to none; a comment annotates only the code it sits on. No counts or rosters in prose (CLAUDE.md, *Comment Discipline*).
- Stage exact paths, never `git add -A` / `git add .`. Quote paths containing parentheses: `"src/app/(teacher)/inbox/page.tsx"`.
- Worktree: integration and e2e run against the worktree's own app. Run `pnpm run worktree:up` once before `--project integration` or `playwright test`. Never touch `:3000`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` and name `(#663)`. Never write the auto-close phrases for issue numbers in commits or docs.

## Review Focus

1. Rows sharing one `createdAt` that straddle a page boundary: none may repeat or vanish (Task 1 integration test; Task 3 e2e).
2. A dual-role account's `/inbox` must never receive student-side rows, nor `/updates` teacher-side rows, through the older-page fetch (Task 1 `recipientType` test; Task 2 asserts the query string carries the audience).
3. A cursor is not an authorization token: a cursor built from another recipient's row, sent by a different session, must return only the caller's own rows (Task 1 test).
4. A `router.refresh()` between two clicks (a new row arrives, the old row 50 slides out of the refreshed first page): the list must show every row exactly once (Task 2 test).
5. A fetch failure, and a double click while a fetch is in flight, must neither lose the cursor nor fetch twice (Task 2 tests).
6. A recipient with exactly one full page of rows must not be offered a button that opens an empty page (Task 1 exact-fit test).

---

### Task 1: Keyset paging lib, service, and API route

**Files:**
- Create: `src/lib/notification-paging.ts`
- Create: `src/lib/notification-paging.test.ts`
- Modify: `src/services/notifications.ts` (add `listNotificationPage` and its types after `markAsRead`, add imports)
- Modify: `src/app/api/notifications/route.ts` (replace the handler body)
- Create: `tests/integration/notifications-list-api.test.ts`
- Modify: `tests/integration/account-api.test.ts` (the `GET /api/notifications — dual account` block, currently asserts `total`)

**Interfaces:**
- Produces (`@/lib/notification-paging`, client-safe):
  ```ts
  export const NOTIFICATION_PAGE_SIZE = 50;
  export const NOTIFICATION_MAX_PAGE_SIZE = 100;
  export interface NotificationCursor { createdAt: Date; id: string }
  export function encodeNotificationCursor(row: NotificationCursor): string;
  export function decodeNotificationCursor(raw: string): NotificationCursor | null;
  export function mergeNotifications(fresh: readonly Notification[], older: readonly Notification[]): Notification[];
  ```
  (`Notification` is the `@prisma/client` type, imported with `import type`.)
- Produces (`@/services/notifications`):
  ```ts
  export interface NotificationRecipient { recipientType: RecipientType; recipientId: string }
  export interface NotificationPage {
    notifications: Notification[];
    hrefById: Record<string, string | null>;
    nextCursor: string | null;
  }
  export async function listNotificationPage(
    db: Db,
    recipients: readonly NotificationRecipient[],
    opts: { limit: number; before?: NotificationCursor },
  ): Promise<NotificationPage>;
  ```
- Produces (HTTP): `GET /api/notifications?before=&limit=&recipientType=` answering `{ data: NotificationPage }` (dates serialised as ISO strings by JSON).

- [ ] **Step 1: Write the failing unit tests** in `src/lib/notification-paging.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type { Notification } from '@prisma/client';
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  mergeNotifications,
} from './notification-paging';

function row(id: string, iso: string, over: Partial<Notification> = {}): Notification {
  return {
    id, recipientType: 'teacher', recipientId: 't-1', type: 'announcement',
    title: id, body: 'b', relatedClassId: null, isRead: false, emailSent: false,
    createdAt: new Date(iso), updatedAt: new Date(iso), ...over,
  };
}

describe('notification cursor', () => {
  it('round-trips a row exactly, milliseconds included', () => {
    const createdAt = new Date('2026-09-15T10:00:00.123Z');
    const decoded = decodeNotificationCursor(encodeNotificationCursor({ createdAt, id: 'abc-123' }));
    expect(decoded?.id).toBe('abc-123');
    expect(decoded?.createdAt.getTime()).toBe(createdAt.getTime());
  });

  it('keeps an id that itself contains a dot', () => {
    const decoded = decodeNotificationCursor(
      encodeNotificationCursor({ createdAt: new Date(1000), id: 'a.b' }),
    );
    expect(decoded?.id).toBe('a.b');
  });

  it.each(['', 'abc', '.x', '12.', 'NaN.x', '-5.x', '1e3.x', '99999999999999999.x', `1000.${'x'.repeat(65)}`])(
    'rejects %j',
    (raw) => {
      expect(decodeNotificationCursor(raw)).toBeNull();
    },
  );
});

describe('mergeNotifications', () => {
  it('returns the union by id, newest first, id descending on a tie', () => {
    const merged = mergeNotifications(
      [row('c', '2026-09-15T10:00:00Z'), row('b', '2026-09-15T09:00:00Z')],
      [row('a', '2026-09-15T09:00:00Z'), row('z', '2026-09-15T08:00:00Z')],
    );
    expect(merged.map((n) => n.id)).toEqual(['c', 'b', 'a', 'z']);
  });

  it('shows a row that is in both lists once, taking the fresh copy', () => {
    const merged = mergeNotifications(
      [row('b', '2026-09-15T09:00:00Z', { isRead: true })],
      [row('b', '2026-09-15T09:00:00Z', { isRead: false }), row('a', '2026-09-15T08:00:00Z')],
    );
    expect(merged.map((n) => n.id)).toEqual(['b', 'a']);
    expect(merged[0]?.isRead).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run --project unit src/lib/notification-paging.test.ts`
Expected: FAIL, cannot resolve `./notification-paging`.

- [ ] **Step 3: Implement `src/lib/notification-paging.ts`**

```ts
import type { Notification } from '@prisma/client';

export const NOTIFICATION_PAGE_SIZE = 50;
export const NOTIFICATION_MAX_PAGE_SIZE = 100;

const MAX_CURSOR_ID_LENGTH = 64;

export interface NotificationCursor {
  createdAt: Date;
  id: string;
}

export function encodeNotificationCursor(row: NotificationCursor): string {
  return `${row.createdAt.getTime()}.${row.id}`;
}

export function decodeNotificationCursor(raw: string): NotificationCursor | null {
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const epochMs = raw.slice(0, dot);
  const id = raw.slice(dot + 1);
  if (!/^\d{1,15}$/.test(epochMs)) return null;
  if (id.length === 0 || id.length > MAX_CURSOR_ID_LENGTH) return null;
  const createdAt = new Date(Number(epochMs));
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

export function mergeNotifications(
  fresh: readonly Notification[],
  older: readonly Notification[],
): Notification[] {
  const byId = new Map<string, Notification>();
  for (const n of older) byId.set(n.id, n);
  for (const n of fresh) byId.set(n.id, n);
  return [...byId.values()].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run --project unit src/lib/notification-paging.test.ts`
Expected: PASS. If `1e3.x` or another `it.each` case passes for the wrong reason, fix the regex, not the case.

- [ ] **Step 5: Write the failing integration tests** in `tests/integration/notifications-list-api.test.ts`

Model the fixture on the dual-account setup in `tests/integration/account-api.test.ts` (one `Account` carrying a `Teacher` and a `Student`, `seedSession` for its token) plus a second, unrelated teacher account. Use `BASE_URL`, `cookie`, `uniqueSuffix`, `seedSession` from `../helpers`; clean up every row by id in `afterAll` (notifications by `recipientId`, then sessions, teachers/students, accounts, in FK order as `notifications-api.test.ts` does). Give every seeded `Notification` an explicit `createdAt`.

Seed for the dual account's **teacher** hat: 3 rows at `T+2s`, 5 rows at exactly `T` (the tie group), 3 rows at `T-2s` (11 rows). Seed 2 **student**-hat rows (type `teacher_invitation`) and 2 teacher-hat rows of type `teacher_invitation` for the href test. Seed 4 rows for the other teacher.

Tests (each `authed(path, token)` is `fetch(BASE_URL + path, { headers: cookie(token) })`):

```ts
type Page = {
  notifications: Array<{ id: string; recipientType: string; recipientId: string }>;
  hrefById: Record<string, string | null>;
  nextCursor: string | null;
};
async function getPage(token: string, query: string): Promise<{ status: number; page: Page }> {
  const res = await authed(`/api/notifications?${query}`, token);
  const body = (await res.json()) as { data: Page };
  return { status: res.status, page: body.data };
}
```

1. **walks a tie group straddling the boundary without repeat or gap** (Review Focus 1). With `recipientType=teacher&limit=4` (boundary falls inside the 5-row tie group: 3 newer rows + 1 of the tie group), follow `nextCursor` until null, collecting ids. Expected order is read from the database, not recomputed in JS: `prisma.notification.findMany({ where: { recipientType: 'teacher', recipientId: dualTeacherId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })`. Assert the collected ids `toEqual` that list, that `new Set(ids).size === ids.length`, and that the walk took 3 requests (4 + 4 + 3 rows).
2. **exact fit has no next page** (Review Focus 6): `limit=11` on the same hat returns 11 rows and `nextCursor === null`; `limit=10` returns 10 rows and a non-null cursor.
3. **`recipientType` narrows a dual-role account** (Review Focus 2): `recipientType=student` returns only `recipientType === 'student'` rows and `recipientType=teacher` only teacher rows; with no `recipientType` both hats appear.
4. **hrefById is computed per row from its own hat**: the student-hat `teacher_invitation` row maps to `/account/privacy`; the teacher-hat `teacher_invitation` row maps to `/inbox/invitations`. Import both paths from `@/lib/notification-links` (`STUDENT_INVITATION_PATH`, `TEACHER_INVITATION_PATH`) rather than repeating the literals.
5. **a cursor is not an authorization token** (Review Focus 3): take `nextCursor` from a page of the *other* teacher's rows, request `/api/notifications?before=<that cursor>` as the dual account, and assert every returned row has the dual account's `recipientId`, none the other teacher's.
6. **400 on a malformed cursor and on a bad `recipientType`**: `before=garbage`, `before=` (empty), `recipientType=admin`.
7. **`limit` degrades and clamps**: `limit=abc` returns 200; `limit=0` returns exactly 1 row.
8. **401 with no session cookie.**

Also edit the `GET /api/notifications — dual account` test in `account-api.test.ts`: drop the `total` field from the body type and the `expect(body.data.total).toBe(2)` line, rename the test to `returns both profiles’ notifications`.

- [ ] **Step 6: Run to verify failure**

Run (after `pnpm run worktree:up`): `pnpm exec vitest run --project integration tests/integration/notifications-list-api.test.ts tests/integration/account-api.test.ts`
Expected: the new file FAILS (no `nextCursor`/`hrefById`, no 400s); `account-api` still passes.

- [ ] **Step 7: Implement the service.** In `src/services/notifications.ts` add these imports (merge with the existing import lines):

```ts
import { studentNotificationHref, teacherNotificationHref } from '@/lib/notification-links';
import { encodeNotificationCursor, type NotificationCursor } from '@/lib/notification-paging';
```

and after `markAsRead`, a new section:

```ts
// ---------------------------------------------------------------------------
// Reading the inbox
// ---------------------------------------------------------------------------

export interface NotificationRecipient {
  recipientType: RecipientType;
  recipientId: string;
}

export interface NotificationPage {
  notifications: Notification[];
  hrefById: Record<string, string | null>;
  nextCursor: string | null;
}

/**
 * One page of the recipients' notifications, newest first, `createdAt desc,
 * id desc` — the id breaks ties between rows created in the same instant
 * (batch inserts), which is what keeps a page boundary from splitting a tie
 * group. Keyset, not offset: rows arrive at the head while a reader is
 * mid-list, and a `skip` would shift under them.
 *
 * Reads `limit + 1` rows; the extra one is the answer to "is there more", so
 * there is no count query and no empty trailing page.
 */
export async function listNotificationPage(
  db: Db,
  recipients: readonly NotificationRecipient[],
  opts: { limit: number; before?: NotificationCursor },
): Promise<NotificationPage> {
  if (recipients.length === 0) return { notifications: [], hrefById: {}, nextCursor: null };
  const { limit, before } = opts;

  const rows = await db.notification.findMany({
    where: {
      OR: recipients.map((r) => ({ recipientType: r.recipientType, recipientId: r.recipientId })),
      ...(before && {
        AND: [
          {
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          },
        ],
      }),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: {
      relatedClass: {
        select: {
          id: true,
          status: true,
          calendarEntry: {
            select: { cancelledAt: true, teacher: { select: { pageSlug: true } } },
          },
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const hrefById: Record<string, string | null> = {};
  const notifications = rows.slice(0, limit).map(({ relatedClass, ...notification }) => {
    hrefById[notification.id] =
      notification.recipientType === 'student'
        ? studentNotificationHref({ type: notification.type, relatedClass })
        : teacherNotificationHref(notification);
    return notification;
  });
  const last = notifications[notifications.length - 1];
  return { notifications, hrefById, nextCursor: hasMore && last ? encodeNotificationCursor(last) : null };
}
```

- [ ] **Step 8: Implement the route.** Replace the body of `src/app/api/notifications/route.ts`'s handler (keep the `session` lines; keep the dual-role `recipients` construction and its comment) with:

```ts
  const url = new URL(request.url);
  // A non-numeric limit is NaN, and Math.max(1, NaN) is NaN — degrade it to the
  // default rather than a 500.
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isNaN(rawLimit)
    ? NOTIFICATION_PAGE_SIZE
    : Math.min(NOTIFICATION_MAX_PAGE_SIZE, Math.max(1, rawLimit));

  // A bad cursor is refused, not degraded to page one: a client that keeps
  // sending it would loop over the first page forever.
  const rawBefore = url.searchParams.get('before');
  const before = rawBefore === null ? undefined : decodeNotificationCursor(rawBefore);
  if (before === null) return respondError('Invalid cursor', 400);

  const rawType = url.searchParams.get('recipientType');
  if (rawType !== null && rawType !== 'teacher' && rawType !== 'student') {
    return respondError('Invalid recipientType', 400);
  }

  const profiles = [ /* the existing teacher/student recipients array, unchanged */ ];
  const recipients = profiles.filter((r) => rawType === null || r.recipientType === rawType);

  const page = await listNotificationPage(prisma, recipients, { limit, before });
  return respondTyped<NotificationPage>(page);
```

Import `respondTyped` (as `src/app/api/waitlist/[id]/route.ts` does), `NOTIFICATION_PAGE_SIZE`, `NOTIFICATION_MAX_PAGE_SIZE`, `decodeNotificationCursor`, `listNotificationPage`, `NotificationPage`; drop the now-unused `respondOk` import. If `exactOptionalPropertyTypes` rejects `before: undefined`, build the options object conditionally.

- [ ] **Step 9: Run to verify pass**

Run: `pnpm exec vitest run --project integration tests/integration/notifications-list-api.test.ts tests/integration/account-api.test.ts tests/integration/notifications-api.test.ts` then `pnpm exec tsc --noEmit`.
Expected: PASS, no type errors.

- [ ] **Step 10: Prove each guard bites.** For each mutation: apply, run the integration file, record the exact failing test name and assertion text, then restore (`git diff` empty for that file before the next mutation; commit first so a restore never eats other work). Record all in the task report.
  1. `orderBy: [{ createdAt: 'desc' }]` (drop the id tie-breaker) → test 1 must fail.
  2. Delete the `{ createdAt: before.createdAt, id: { lt: before.id } }` branch → test 1 must fail (rows in the tie group vanish).
  3. Change `lt` to `lte` on `createdAt` → test 1 must fail (repeats).
  4. Drop the `recipients.filter(...)` → test 3 must fail.
  5. Replace the `where.OR` recipients with no recipient constraint → tests 3 and 5 must fail.
  6. `hasMore = rows.length >= limit` → test 2 must fail.
  If a mutation does not fail a test, the test is wrong: fix the test, not the mutation.

- [ ] **Step 11: Commit**

```bash
git add src/lib/notification-paging.ts src/lib/notification-paging.test.ts src/services/notifications.ts src/app/api/notifications/route.ts tests/integration/notifications-list-api.test.ts tests/integration/account-api.test.ts
git commit -m "feat(notifications): keyset-paginate the inbox read behind one service (#663)"
```

---

### Task 2: "Show older messages" in `NotificationList`

**Files:**
- Modify: `src/components/layout/notification-list.tsx`
- Modify: `src/components/layout/notification-list.test.tsx` (add a describe block)

**Interfaces:**
- Consumes: `NOTIFICATION_PAGE_SIZE`, `mergeNotifications` from `@/lib/notification-paging`; the `GET /api/notifications` contract of Task 1 (`{ data: { notifications, hrefById, nextCursor } }`, dates as ISO strings).
- Produces: `NotificationList` prop `paging?: { audience: RecipientType; nextCursor: string | null }`. Row primary buttons get `id="notification-row-<notification.id>"`.

- [ ] **Step 1: Write the failing tests** — append to `notification-list.test.tsx` (reuse its `notification()` helper; add `routerRefresh` to the existing import from `tests/setup/components`).

```tsx
function olderResponse(notifications: Notification[], nextCursor: string | null, hrefById: Record<string, string | null> = {}) {
  return {
    ok: true,
    json: async () => ({ data: { notifications, hrefById, nextCursor } }),
  };
}
const rowIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[id^="notification-row-"]')).map((el) => el.id.replace('notification-row-', ''));
const at = (mins: number) => new Date(Date.UTC(2026, 8, 15, 10, 0) - mins * 60_000);

describe('NotificationList — show older (#663)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('offers no button without paging, or when the cursor is null', () => {
    const { rerender } = render(<NotificationList notifications={[notification({ id: 'a' })]} />);
    expect(screen.queryByRole('button', { name: 'Show older messages' })).toBeNull();
    rerender(<NotificationList notifications={[notification({ id: 'a' })]} paging={{ audience: 'teacher', nextCursor: null }} />);
    expect(screen.queryByRole('button', { name: 'Show older messages' })).toBeNull();
  });

  it('fetches the next page for its audience, appends it below, and drops the button at the end', async () => {
    const fetchMock = vi.fn().mockResolvedValue(olderResponse([notification({ id: 'b', createdAt: at(5) })], null));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      <NotificationList
        notifications={[notification({ id: 'a', createdAt: at(1) })]}
        paging={{ audience: 'teacher', nextCursor: 'cursor-1' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));

    await vi.waitFor(() => expect(rowIds(container)).toEqual(['a', 'b']));
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://x');
    expect(url.pathname).toBe('/api/notifications');
    expect(url.searchParams.get('recipientType')).toBe('teacher');
    expect(url.searchParams.get('before')).toBe('cursor-1');
    expect(screen.queryByRole('button', { name: 'Show older messages' })).toBeNull();
  });

  it('keeps the button and resumes from the new cursor while more remain', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(olderResponse([notification({ id: 'b', createdAt: at(5) })], 'cursor-2'))
      .mockResolvedValueOnce(olderResponse([notification({ id: 'c', createdAt: at(9) })], null));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      <NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} paging={{ audience: 'teacher', nextCursor: 'cursor-1' }} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    await vi.waitFor(() => expect(rowIds(container)).toEqual(['a', 'b']));
    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));

    await vi.waitFor(() => expect(rowIds(container)).toEqual(['a', 'b', 'c']));
    expect(new URL(String(fetchMock.mock.calls[1]?.[0]), 'http://x').searchParams.get('before')).toBe('cursor-2');
  });

  it('marks a later-loaded row read through the same path, and shows an already-read one as read', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(olderResponse([
        notification({ id: 'b', title: 'Old unread', isRead: false, createdAt: at(5) }),
        notification({ id: 'c', title: 'Old read', isRead: true, createdAt: at(6) }),
      ], null))
      .mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    const markUnread = await screen.findByRole('button', { name: 'Mark "Old unread" read' });
    expect(screen.getByRole('button', { name: 'Mark "Old read" read' })).toHaveClass('invisible');
    expect(markUnread).not.toHaveClass('invisible');

    fireEvent.click(markUnread);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/notifications/b/read', { method: 'POST' }));
    expect(screen.getByRole('button', { name: 'Mark "Old unread" read' })).toHaveClass('invisible');
  });

  it('opens a later-loaded row on the href the API sent for it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(olderResponse(
      [notification({ id: 'b', title: 'Old invite', type: 'teacher_invitation', createdAt: at(5) })], null, { b: '/account/privacy' },
    )).mockResolvedValue({ ok: true }));
    render(<NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} hrefById={{ a: null }} paging={{ audience: 'student', nextCursor: 'c1' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Old invite/ }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith('/account/privacy'));
  });

  it('shows every row once when the page refreshes between clicks (Review Focus 4)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(olderResponse([
      notification({ id: 'n3', createdAt: at(3) }),
      notification({ id: 'n2', createdAt: at(4) }),
    ], 'c2')));
    const first = [notification({ id: 'n5', createdAt: at(1) }), notification({ id: 'n4', createdAt: at(2) })];
    const { container, rerender } = render(<NotificationList notifications={first} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    await vi.waitFor(() => expect(rowIds(container)).toEqual(['n5', 'n4', 'n3', 'n2']));

    // A new row arrives; the server re-renders the first page with n4 slid out.
    rerender(
      <NotificationList
        notifications={[notification({ id: 'n6', createdAt: at(0) }), notification({ id: 'n5', createdAt: at(1) })]}
        paging={{ audience: 'teacher', nextCursor: 'c-after-refresh' }}
      />,
    );

    expect(rowIds(container)).toEqual(['n6', 'n5', 'n4', 'n3', 'n2']);
    // The cursor is the one the last fetch returned, not the refreshed page's.
    expect(screen.getByRole('button', { name: 'Show older messages' })).toBeInTheDocument();
  });

  it('says so on a failed fetch, keeps the cursor, and succeeds on retry (Review Focus 5)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(olderResponse([notification({ id: 'b', createdAt: at(5) })], null));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load older messages.");

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    await vi.waitFor(() => expect(rowIds(container)).toEqual(['a', 'b']));
    expect(new URL(String(fetchMock.mock.calls[1]?.[0]), 'http://x').searchParams.get('before')).toBe('c1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('fetches once when clicked twice while a fetch is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationList notifications={[notification({ id: 'a' })]} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);

    const button = screen.getByRole('button', { name: 'Show older messages' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(olderResponse([], null));
  });

  it('moves focus to the first loaded row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(olderResponse([notification({ id: 'b', title: 'Loaded', createdAt: at(5) })], null)));
    render(<NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));

    await vi.waitFor(() => expect(screen.getByRole('button', { name: /^Loaded/ })).toHaveFocus());
  });
});
```

The API response carries dates as ISO strings; make `olderResponse` do the same by mapping `createdAt`/`updatedAt` through `.toISOString()` in its `json`, so the test exercises the revival in the component. (Adjust the helper accordingly.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run --project components src/components/layout/notification-list.test.tsx`
Expected: the new block FAILS (no button, no `paging` prop); the two earlier describes still pass.

- [ ] **Step 3: Implement.** In `notification-list.tsx`:

  a. Imports: add `useEffect, useRef` to the react import; `import type { Notification, RecipientType } from '@prisma/client';`; `import { NOTIFICATION_PAGE_SIZE, mergeNotifications } from '@/lib/notification-paging';`.

  b. Props and local types:

```tsx
interface NotificationListProps {
  notifications: Notification[];
  hrefById?: Record<string, string | null>;
  /** Present when older rows may exist: which recipient hat to read, and where to resume. */
  paging?: { audience: RecipientType; nextCursor: string | null };
}

type Serialized<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] };

interface OlderPageBody {
  notifications: Serialized<Notification>[];
  hrefById: Record<string, string | null>;
  nextCursor: string | null;
}

interface Loaded {
  rows: Notification[];
  hrefById: Record<string, string | null>;
  nextCursor: string | null;
}

function reviveNotification(n: Serialized<Notification>): Notification {
  return { ...n, createdAt: new Date(n.createdAt), updatedAt: new Date(n.updatedAt) };
}

const rowButtonId = (id: string) => `notification-row-${id}`;
```

  c. Inside the component, after `readState`:

```tsx
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const inFlight = useRef(false);
  const pendingFocus = useRef<string | null>(null);

  const rows = loaded ? mergeNotifications(notifications, loaded.rows) : notifications;
  const hrefs = hrefById ? { ...loaded?.hrefById, ...hrefById } : undefined;
  const nextCursor = loaded ? loaded.nextCursor : (paging?.nextCursor ?? null);

  useEffect(() => {
    if (pendingFocus.current === null) return;
    document.getElementById(rowButtonId(pendingFocus.current))?.focus();
    pendingFocus.current = null;
  }, [loaded]);

  async function showOlder() {
    if (inFlight.current || nextCursor === null || !paging) return;
    inFlight.current = true;
    setStatus('loading');
    try {
      const params = new URLSearchParams({
        recipientType: paging.audience,
        before: nextCursor,
        limit: String(NOTIFICATION_PAGE_SIZE),
      });
      const res = await fetch(`/api/notifications?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: OlderPageBody };
      const older = body.data.notifications.map(reviveNotification);
      pendingFocus.current = older[0]?.id ?? null;
      setLoaded({
        rows: mergeNotifications(rows, older),
        hrefById: { ...hrefs, ...body.data.hrefById },
        nextCursor: body.data.nextCursor,
      });
      setStatus('idle');
    } catch {
      setStatus('failed');
    } finally {
      inFlight.current = false;
    }
  }
```

  d. Replace `resolveHref`'s first line with `if (hrefs) return hrefs[notification.id] ?? null;`. Render from `rows` instead of `notifications` (the empty check and the `.map`). Give each row's primary `<button>` `id={rowButtonId(notification.id)}`.

  e. Between the rows `.map(...)` and the `<div className="pt-4">` retention note, add:

```tsx
      {nextCursor !== null && (
        <div className="pt-2">
          {status === 'failed' && (
            <p role="alert" className="type-caption text-danger">
              Couldn&apos;t load older messages.
            </p>
          )}
          <button
            type="button"
            onClick={showOlder}
            disabled={status === 'loading'}
            className="type-label text-teal min-h-[44px]"
          >
            {status === 'loading' ? 'Loading…' : 'Show older messages'}
          </button>
        </div>
      )}
```

  Note the failure copy in the test is `Couldn't` with a straight apostrophe; the JSX entity renders it identically.

  The loading label changes the button's accessible name, which is why the double-click test clicks the same element reference rather than re-querying by name.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run --project components src/components/layout/notification-list.test.tsx` then `pnpm exec tsc --noEmit` and `pnpm exec eslint src/components/layout/notification-list.tsx`.
Expected: PASS, no type or lint errors. If `react-hooks` lint flags the effect or the refs, satisfy it structurally, do not disable the rule.

- [ ] **Step 5: Prove each guard bites** (commit first; record failing test names and messages in the report; restore after each):
  1. `mergeNotifications(rows, older)` inside `setLoaded` replaced with `older` only (drop the carried first page) → the refresh test must fail with n4 missing.
  2. `const rows = loaded ? loaded.rows : notifications` (ignore the refreshed prop) → the refresh test must fail with n6 missing.
  3. Remove the `inFlight.current` guard from `showOlder` → the double-click test must fail (`toHaveBeenCalledTimes(1)` received 2).
  4. Remove `setStatus('failed')` from the catch → the failure test must fail (no alert).
  5. Delete the `pendingFocus.current = …` line → the focus test must fail.
  6. Drop `recipientType: paging.audience` from `URLSearchParams` → the fetch-URL test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/notification-list.tsx src/components/layout/notification-list.test.tsx
git commit -m "feat(inbox): a Show older messages control that resumes from a cursor (#663)"
```

---

### Task 3: Wire both pages, docs, and an end-to-end test

**Files:**
- Modify: `"src/app/(teacher)/inbox/page.tsx"`
- Modify: `"src/app/(student)/updates/page.tsx"`
- Modify: `docs/data-model.md` (Notification section)
- Create: `tests/e2e/inbox-older.spec.ts`

**Interfaces:**
- Consumes: `listNotificationPage`, `NOTIFICATION_PAGE_SIZE`, `NotificationList`'s `paging` and `hrefById` props from Tasks 1 and 2.

- [ ] **Step 1: Write the failing e2e test** `tests/e2e/inbox-older.spec.ts`, modelled on `tests/e2e/invitations.spec.ts` (its `PrismaClient`, `uniqueSuffix`, `seedSession`, `sessionCookie` fixtures and its teacher/student setup; read `tests/e2e/fixtures.ts` and `page-helpers.ts` `hydrationSignal` first). Two tests, one teacher and one student, each owning their seeded rows and cleaning them in `afterAll`:

  Seed 55 notifications for the recipient with `createMany`: titles `E2E notice ${i}` for `i` in `0..54`, `createdAt = base − Math.floor(i / 6) × 1000 ms`, so they sit in groups of six that share an instant and the 50/51 boundary falls inside a group. (For the student use type `announcement`; for the teacher the same.)

  Teacher test: sign in, `goto('/inbox')` with `hydrationSignal` armed, assert `page.locator('[id^="notification-row-"]')` has count 50 and the retention note is visible, click `Show older messages`, assert count 55 and that all 55 titles appear exactly once (`E2E notice 0`…`54`, checking each with an exact-text locator count of 1, or one `allTextContents` set-size check), and that the button is gone.

  Student test: the same against `/updates`.

- [ ] **Step 2: Run to verify failure**

Run (after `pnpm run worktree:up`): `pnpm exec playwright test tests/e2e/inbox-older.spec.ts`
Expected: FAIL — 50 rows shown, no `Show older messages` button.

- [ ] **Step 3: Implement the teacher page**

```tsx
import { requireTeacherSession } from '@/lib/session';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/layout/page-header';
import { NotificationList } from '@/components/layout/notification-list';
import { listNotificationPage } from '@/services/notifications';
import { NOTIFICATION_PAGE_SIZE } from '@/lib/notification-paging';

export default async function InboxPage() {
  const session = await requireTeacherSession();

  const { notifications, hrefById, nextCursor } = await listNotificationPage(
    prisma,
    [{ recipientType: 'teacher', recipientId: session.teacherId }],
    { limit: NOTIFICATION_PAGE_SIZE },
  );

  return (
    <>
      <PageHeader title="Inbox" backHref={null} variant="display" />
      <NotificationList
        notifications={notifications}
        hrefById={hrefById}
        paging={{ audience: 'teacher', nextCursor }}
      />
    </>
  );
}
```

  Keep any existing imports the file still needs; drop what it no longer uses.

- [ ] **Step 4: Implement the student page.** In `"src/app/(student)/updates/page.tsx"` replace the inline `findMany`, the `hrefById` derivation and the leading docblock with a `listNotificationPage(prisma, [{ recipientType: 'student', recipientId: session.studentId }], { limit: NOTIFICATION_PAGE_SIZE })` call, and render `<NotificationList notifications={notifications} hrefById={hrefById} paging={{ audience: 'student', nextCursor }} />`. Drop the now-unused `studentNotificationHref` import. Replace the comment above the component with one line stating what is true: `// The student's notifications, newest first; older ones load on request. The strip on /bookings previews unread (communication layer 2).` Keep `export const dynamic = 'force-dynamic'`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec playwright test tests/e2e/inbox-older.spec.ts`, then `pnpm exec tsc --noEmit`.
Expected: PASS.

- [ ] **Step 6: Prove the e2e bites.** Commit first, then: (1) drop the `id` tie-breaker in `listNotificationPage`'s `orderBy` → the e2e must fail on a missing or repeated title; (2) render `paging={undefined}` on `/inbox` → it must fail with count 50 and no button. Restore after each; record the failure text.

- [ ] **Step 7: Docs.** In `docs/data-model.md`, in `### Notification (inbox item)`, add a paragraph after the retention paragraph:

  > The inbox pages (`/inbox`, `/updates`) and `GET /api/notifications` read through one service, `listNotificationPage` (`src/services/notifications.ts`): newest first, `createdAt desc, id desc`, in keyset pages of `NOTIFICATION_PAGE_SIZE` (`src/lib/notification-paging.ts`). The id breaks ties between rows created in the same instant, which is what stops a page boundary from splitting a batch insert; a cursor is the last row's `(createdAt, id)`, so rows arriving at the head while a reader scrolls never shift what comes next. The read filters on `(recipient_type, recipient_id)`, the prefix of the existing index, and sorts within one recipient's rows; there is still no index on `created_at`, for the write-cost reason above.

  Also add one sentence to the inbox paragraph of `docs/information-architecture.md` (search for "The inbox is also where") saying older messages load through a "Show older messages" control at the bottom of the list.

- [ ] **Step 8: Full verification.** Run `pnpm run verify` (worktree app up). Expected: green. Report the per-project arithmetic (unit + components + integration = total) as printed.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(teacher)/inbox/page.tsx" "src/app/(student)/updates/page.tsx" tests/e2e/inbox-older.spec.ts docs/data-model.md docs/information-architecture.md
git commit -m "feat(inbox): both inbox pages page through every stored notification (#663)"
```
