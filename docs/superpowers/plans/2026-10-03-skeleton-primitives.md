# Skeleton Primitives Implementation Plan (#740)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every loading skeleton is drawn through the same layout primitive as the page it stands in for, every route's loading state is a recorded choice, and a test catches a page that silently inherits another page's skeleton.

**Architecture:** Layout frames (`ListRow`, `PageHeader`, `ScheduleHeader`, `Card`/`ClassCard`/`StudioClassCard`, the `ClassList` week section) each export a `*Skeleton` from the same file, rendered through the same frame. Tab roots move into `(overview)` route groups so their `loading.tsx` covers only themselves; everything else falls back to a neutral header skeleton. Two filesystem unit tests pin the row recipe and loading coverage; a Playwright spec compares skeleton and page geometry.

**Tech Stack:** Next.js 16.3.4 App Router, React 19, Tailwind v4, Vitest (unit + jsdom `components` project), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-skeleton-primitives-design.md` — read it first; this plan argues from it.

## Global Constraints

- **No visual change to any real page.** Every migrated element keeps its tag and its class **set** (order may change; membership may not). Each task's report lists, per site, the before and after class set.
- No motion, no shimmer, no new dependency.
- TypeScript strict; no `any`; no `as` casts to widen.
- Comment Discipline (CLAUDE.md): no counts or member rosters in comments; comments annotate the code they sit on; nothing like "this used to…".
- Stage exact paths; quote paths with parentheses: `"src/app/(teacher)/..."`. Never `git add -A`/`git add .`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and name `(#740)`.
- Shell: prefix commands with `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH:/usr/sbin &&`. Work only in `/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-740`. Never touch the server on :3000. The worktree's own dev server is on :3107 (`pnpm run worktree:up` if not running; `INTEGRATION_BASE_URL` comes from `.env`).
- **Bar widths:** a `SkeletonText` that is a flex item in a row (`flex items-center …`) sizes to its content, so a fractional width (`w-2/5`) resolves against nothing and the bar collapses to zero width. In a flex row use a fixed width (`w-20`, `w-32`); fractions only where the line is a block or a stretched column item.
- Inner loops: `pnpm exec vitest run --project unit <file>`, `pnpm exec vitest run --project components <file>`, `pnpm exec tsc --noEmit`, `pnpm exec eslint <files>`.
- **Task order is load-bearing:** T1 → T2 → T3 → T4 → T5 → T6. T4 composes everything T1–T3 export; T5 measures anchors T2/T4 place; T6 attests renders after every visual-affecting change.

## Review Focus

1. **A migrated row whose class set changed** (dropped `last:border-b-0`, `py-2`↔`py-3` swapped, `no-underline` lost on a Link) — a real page shifts by a few px. Pinned by: every task's per-site class-set table, plus the visual suite in T6.
2. **A skeleton line whose height is not the real line's height** (a fixed `h-4` where the text is `type-display`) — the page jumps. Pinned by `SkeletonText` carrying the type utility (T1 test) and the T5 geometry spec.
3. **A page under an `(overview)` group that still inherits a parent's skeleton**, or a nested page that now inherits the tab root's list — pinned by the T4 coverage test's `group` kind check.
4. **The geometry e2e passing vacuously** (no skeleton shown, page compared with itself) — pinned by T5 asserting the `aria-busy` skeleton is visible and the hold state is `holding` before measuring.
5. **Skeleton bars invisible on a card** (`bg-sand-soft` on `bg-sand-soft`) — pinned by T1's `surface` test and T3's card skeleton test asserting `bg-sand`.

---

### Task 1: Content placeholders and the `ListRow` primitive

**Files:**
- Modify: `src/components/ui/skeleton.tsx`
- Create: `src/components/ui/skeleton.test.tsx`
- Create: `src/components/ui/list-row.tsx`, `src/components/ui/list-row.test.tsx`
- Create: `src/lib/list-row-recipe.test.ts`
- Modify (migrate): every file `grep -rln 'min-h-14' src | grep -v '\.test\.'` lists, except the three split-recipe sites (`src/components/class/outstanding-payment-row.tsx`, `src/components/account/install-app-row.tsx`, `src/components/class/audience-picker.tsx`). This includes the two existing skeletons `src/app/(teacher)/students/loading.tsx` and `src/app/(teacher)/inbox/loading.tsx` (their inline row `div` becomes `ListRowSkeleton`; T4 rewrites them fully).

**Interfaces — Produces:**
```ts
// skeleton.tsx
export type SkeletonSurface = 'page' | 'card';
export type TypeStyle = 'type-display' | 'type-title' | 'type-subtitle' | 'type-body' | 'type-label' | 'type-caption';
export function Skeleton(props: { className?: string; surface?: SkeletonSurface }): JSX.Element;
export function SkeletonText(props: { type: TypeStyle; width: string; surface?: SkeletonSurface; className?: string }): JSX.Element;
// list-row.tsx
export type ListRowDensity = 'regular' | 'relaxed';
export type ListRowDivider = 'between' | 'after-each';
export interface ListRowFrameOptions { density?: ListRowDensity; divider?: ListRowDivider; className?: string }
export function listRowClass(options?: ListRowFrameOptions): string;
export function ListRow(props: ListRowFrameOptions & { children: ReactNode; href?: string }): JSX.Element;
export function ListRowSkeleton(props: ListRowFrameOptions & { lines?: 1 | 2 }): JSX.Element;
```

- [ ] **Step 1: Write the failing component tests.** `src/components/ui/skeleton.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton, SkeletonText } from './skeleton';

describe('Skeleton', () => {
  it('is sand-soft on the page and one sand step darker on a card', () => {
    const { container: page } = render(<Skeleton className="h-4" />);
    const { container: card } = render(<Skeleton className="h-4" surface="card" />);
    expect(page.firstElementChild?.classList.contains('bg-sand-soft')).toBe(true);
    expect(card.firstElementChild?.classList.contains('bg-sand')).toBe(true);
    expect(card.firstElementChild?.classList.contains('bg-sand-soft')).toBe(false);
  });
});

describe('SkeletonText', () => {
  it('carries the type style on a block so its line box is the real line height', () => {
    const { container } = render(<SkeletonText type="type-display" width="w-2/5" className="mt-1" />);
    const line = container.firstElementChild;
    expect(line?.getAttribute('aria-hidden')).toBe('true');
    expect(line?.classList.contains('type-display')).toBe(true);
    expect(line?.classList.contains('mt-1')).toBe(true);
    const bar = line?.firstElementChild;
    expect(bar?.classList.contains('inline-block')).toBe(true);
    expect(bar?.classList.contains('w-2/5')).toBe(true);
    expect(bar?.classList.contains('bg-sand-soft')).toBe(true);
  });

  it('uses the card tone when asked', () => {
    const { container } = render(<SkeletonText type="type-label" width="w-20" surface="card" />);
    expect(container.firstElementChild?.firstElementChild?.classList.contains('bg-sand')).toBe(true);
  });
});
```

`src/components/ui/list-row.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ListRow, ListRowSkeleton, listRowClass } from './list-row';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

describe('listRowClass', () => {
  it('is the 56px directory row: py-2, divider between rows', () => {
    expect(set(listRowClass())).toEqual(set('min-h-14 py-2 border-b border-border last:border-b-0'));
  });
  it('names the relaxed padding and the every-row divider', () => {
    expect(set(listRowClass({ density: 'relaxed', divider: 'after-each', className: 'flex gap-3' })))
      .toEqual(set('min-h-14 py-3 border-b border-border flex gap-3'));
  });
});

describe('ListRow', () => {
  it('renders a div, or a link when given href, through the same frame', () => {
    render(<><ListRow className="flex">A</ListRow><ListRow href="/x" className="flex no-underline">B</ListRow></>);
    expect(set(screen.getByText('A').className)).toEqual(set(listRowClass({ className: 'flex' })));
    const link = screen.getByRole('link', { name: 'B' });
    expect(link.getAttribute('href')).toBe('/x');
    expect(set(link.className)).toEqual(set(listRowClass({ className: 'flex no-underline' })));
  });
});

describe('ListRowSkeleton', () => {
  it('shares the frame with ListRow for the same options', () => {
    const { container } = render(<ListRowSkeleton density="relaxed" divider="after-each" />);
    const row = container.firstElementChild;
    expect(row?.getAttribute('aria-hidden')).toBe('true');
    for (const token of set(listRowClass({ density: 'relaxed', divider: 'after-each' }))) {
      expect(row?.classList.contains(token)).toBe(true);
    }
  });
  it('draws two lines by default and one on request', () => {
    const two = render(<ListRowSkeleton />).container.firstElementChild;
    const one = render(<ListRowSkeleton lines={1} />).container.firstElementChild;
    expect(two?.children.length).toBe(2);
    expect(one?.children.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run them and see them fail** — `pnpm exec vitest run --project components src/components/ui/skeleton.test.tsx src/components/ui/list-row.test.tsx`. Expected: FAIL (`SkeletonText`/`list-row` not found; `bg-sand` absent).

- [ ] **Step 3: Implement.** `src/components/ui/skeleton.tsx`:

```tsx
export type SkeletonSurface = 'page' | 'card';

/** The six type utilities, so a placeholder line borrows a real line's height. */
export type TypeStyle =
  | 'type-display'
  | 'type-title'
  | 'type-subtitle'
  | 'type-body'
  | 'type-label'
  | 'type-caption';

// sand-soft disappears on a sand-soft card, so a bar on a card takes the
// next sand step.
const SURFACE_BG: Record<SkeletonSurface, string> = {
  page: 'bg-sand-soft',
  card: 'bg-sand',
};

interface SkeletonProps {
  className?: string;
  surface?: SkeletonSurface;
}

// A content placeholder — a number, an icon slot — inside a primitive's
// frame. Never a stand-in for a whole card or row: those come from the
// primitive's own *Skeleton (docs/design-brief.md, Loading states).
// Static sand: no shimmer, no spinner.
export function Skeleton({ className = '', surface = 'page' }: SkeletonProps) {
  return <div aria-hidden="true" className={`${SURFACE_BG[surface]} rounded-[4px] ${className}`.trim()} />;
}

interface SkeletonTextProps {
  type: TypeStyle;
  /** A Tailwind width class for the bar, e.g. "w-2/5". */
  width: string;
  surface?: SkeletonSurface;
  className?: string;
}

// One line of placeholder text. The block carries the type utility, so its
// line box is that style's line-height; the bar inside is shorter than the
// line and centred, so it never sets the height itself.
export function SkeletonText({ type, width, surface = 'page', className = '' }: SkeletonTextProps) {
  return (
    <div aria-hidden="true" className={`${type} ${className}`.trim()}>
      <span className={`inline-block align-middle h-[0.8em] rounded-[4px] ${SURFACE_BG[surface]} ${width}`} />
    </div>
  );
}
```

`src/components/ui/list-row.tsx`:

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SkeletonText } from './skeleton';

export type ListRowDensity = 'regular' | 'relaxed';
export type ListRowDivider = 'between' | 'after-each';

export interface ListRowFrameOptions {
  /** 'relaxed' for rows carrying a title and a body line. */
  density?: ListRowDensity;
  /** 'after-each' keeps the last row's border, for a list followed by more content. */
  divider?: ListRowDivider;
  /** The row's own layout — flex/grid, gap, alignment, no-underline, opacity. */
  className?: string;
}

const DENSITY: Record<ListRowDensity, string> = { regular: 'py-2', relaxed: 'py-3' };
const DIVIDER: Record<ListRowDivider, string> = {
  between: 'border-b border-border last:border-b-0',
  'after-each': 'border-b border-border',
};

// The ≥56px directory row (docs/design-brief.md). The one place its frame is
// written; a row element that is neither a div nor a link calls this directly.
export function listRowClass({ density = 'regular', divider = 'between', className = '' }: ListRowFrameOptions = {}): string {
  return `min-h-14 ${DENSITY[density]} ${DIVIDER[divider]} ${className}`.trim();
}

interface ListRowProps extends ListRowFrameOptions {
  children: ReactNode;
  href?: string;
}

export function ListRow({ children, href, ...frame }: ListRowProps) {
  const className = listRowClass(frame);
  if (href !== undefined) {
    return <Link href={href} className={className}>{children}</Link>;
  }
  return <div className={className}>{children}</div>;
}

interface ListRowSkeletonProps extends ListRowFrameOptions {
  lines?: 1 | 2;
}

export function ListRowSkeleton({ lines = 2, className = '', ...frame }: ListRowSkeletonProps) {
  return (
    <div aria-hidden="true" className={listRowClass({ ...frame, className: `flex flex-col justify-center gap-1 ${className}`.trim() })}>
      <SkeletonText type="type-body" width="w-2/5" />
      {lines === 2 && <SkeletonText type="type-caption" width="w-3/5" />}
    </div>
  );
}
```

- [ ] **Step 4: Run the component tests** — same command. Expected: PASS.

- [ ] **Step 5: Write the failing recipe tether** `src/lib/list-row-recipe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const RECIPE = 'min-h-14';
const OWNER = 'components/ui/list-row.tsx';

// Sites that split the row recipe across two elements. Each is a different
// geometry from ListRow, and migrating it would change a real page.
const SPLIT_RECIPE_SITES: Readonly<Record<string, string>> = {
  'components/class/outstanding-payment-row.tsx':
    'border and py-2 sit on a wrapper and min-h-14 on the inner row, so its minimum is 72px, not 56',
  'components/account/install-app-row.tsx':
    'the wrapper holds the border so the row can expand to show install steps under its button',
  'components/class/audience-picker.tsx':
    'a checklist label inside a bordered box: px-4, no vertical padding, the border on its li',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [full] : [];
  });
}

const usingRecipe = sourceFiles(SRC)
  .filter((file) => readFileSync(file, 'utf8').includes(RECIPE))
  .map((file) => path.relative(SRC, file).split(path.sep).join('/'));

describe('the directory-row recipe has one owner', () => {
  it('appears only in ListRow and the split-recipe sites', () => {
    const strays = usingRecipe.filter((file) => file !== OWNER && !(file in SPLIT_RECIPE_SITES));
    expect(strays).toEqual([]);
  });

  it('names no split-recipe site that no longer uses it', () => {
    const stale = Object.keys(SPLIT_RECIPE_SITES).filter((file) => !usingRecipe.includes(file));
    expect(stale).toEqual([]);
  });

  it('is still owned by ListRow', () => {
    expect(usingRecipe).toContain(OWNER);
  });
});
```

- [ ] **Step 6: Run it** — `pnpm exec vitest run --project unit src/lib/list-row-recipe.test.ts`. Expected: FAIL on the first test, listing every unmigrated file.

- [ ] **Step 7: Migrate every listed site.** Rules:
  - A `div`/`Link` carrying the whole recipe becomes `<ListRow …>` with `href` for a link; every class other than `min-h-14`, `py-2`/`py-3`, `border-b`, `border-border`, `last:border-b-0` goes into `className`. `py-3` → `density="relaxed"`; a row without `last:border-b-0` → `divider="after-each"`.
  - An element that is not a div/link, or that carries attributes `ListRow` does not accept (`key` is fine; `aria-current`, `data-*`, `id`, `onClick`, a `<li>`): keep the element and set `className={listRowClass({…})}` (`notification-list.tsx` rows, `(public)/verify/page.tsx` steps). Conditional classes go inside `className` as today.
  - `bookings/page.tsx`, `studio-class/[id]/page.tsx`, and the two loading files: same rules (`ListRowSkeleton` for the loading rows, keeping `density` — students `regular`, inbox `relaxed`).
  - For each site, record in your report: file:line, element, class set before, class set after (from `listRowClass`'s output plus `className`). Sets must be equal.

- [ ] **Step 8: Run** the tether, the component tests, `pnpm exec vitest run --project components` (whole project — many migrated components have tests), `pnpm exec tsc --noEmit`, and `pnpm exec eslint` on the touched files. Expected: all PASS.

- [ ] **Step 9: Prove the tether bites.** Each mutation: apply, run the tether, record the exact failing assertion text, restore, confirm `git diff --stat` shows no mutation left.
  1. Add `className="min-h-14"` to any element in `src/components/ui/card.tsx` → first test red naming `components/ui/card.tsx`.
  2. Remove `min-h-14` from `src/components/class/audience-picker.tsx` → second test red naming it.
  3. Change `RECIPE` usage in `list-row.tsx` (rename `min-h-14` to `min-h-[56px]`) → third test red.

- [ ] **Step 10: Commit** — stage the exact files touched (quote parenthesised paths): `feat(ui): ListRow owns the directory-row frame and its skeleton; SkeletonText takes a line's height from its type style (#740)`.

---

### Task 2: Header primitives own their skeletons

**Files:**
- Modify: `src/components/layout/page-header.tsx`; Create: `src/components/layout/page-header.test.tsx`
- Modify: `src/components/ui/avatar.tsx` (+ `AvatarSkeleton`), `src/components/ui/avatar.test.tsx`
- Create: `src/components/schedule/schedule-header.tsx`, `src/components/schedule/schedule-header.test.tsx`
- Modify: `src/app/(teacher)/schedule/page.tsx` (render `ScheduleHeader`)

**Interfaces:**
- Consumes: `SkeletonText`, `Skeleton` (T1).
- Produces:
```ts
export function PageHeaderSkeleton(props: { backHref?: string | null; variant?: 'display' | 'title'; action?: boolean }): JSX.Element;
export function AvatarSkeleton(props: { size: number }): JSX.Element;
export function ScheduleHeader(props: { firstName: string; lastName: string; photoId: string | null; today: string }): JSX.Element;
export function ScheduleHeaderSkeleton(): JSX.Element;
```
Both header frames carry `data-layout-anchor="header"` on their root.

- [ ] **Step 1: Failing tests.** `page-header.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader, PageHeaderSkeleton } from './page-header';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

describe('PageHeaderSkeleton', () => {
  it('shares the header frame and anchor with PageHeader', () => {
    const real = render(<PageHeader title="Rooms" backHref="/settings" backLabel="Settings" />).container.firstElementChild;
    const skel = render(<PageHeaderSkeleton backHref="/settings" />).container.firstElementChild;
    expect(real?.getAttribute('data-layout-anchor')).toBe('header');
    expect(skel?.getAttribute('data-layout-anchor')).toBe('header');
    expect(set(skel?.className)).toEqual(set(real?.className));
  });

  it('draws the back-link slot with the link\'s classes but no link', () => {
    render(<PageHeader title="Rooms" backHref="/settings" backLabel="Settings" />);
    const link = screen.getByRole('link', { name: 'Settings' });
    const { container } = render(<PageHeaderSkeleton />);
    expect(container.querySelector('a')).toBeNull();
    const slot = container.firstElementChild?.firstElementChild;
    for (const token of ['inline-flex', 'items-center', 'gap-1.5', 'type-label', 'mb-2']) {
      expect(link.classList.contains(token)).toBe(true);
      expect(slot?.classList.contains(token)).toBe(true);
    }
  });

  it('has no back slot on a tab page, and the variant\'s title style', () => {
    const { container } = render(<PageHeaderSkeleton backHref={null} variant="display" />);
    const root = container.firstElementChild;
    expect(root?.children.length).toBe(1);
    expect(root?.querySelector('.type-display')).not.toBeNull();
    expect(root?.querySelector('h1')).toBeNull();
  });

  it('draws an action placeholder only when asked', () => {
    const row = (action: boolean) =>
      render(<PageHeaderSkeleton backHref={null} action={action} />).container.firstElementChild?.lastElementChild;
    expect(row(false)?.children.length).toBe(1);
    expect(row(true)?.children.length).toBe(2);
  });
});
```

`schedule-header.test.tsx`: assert `ScheduleHeader` renders `h1` "Schedule", the `today` caption, a `Profile` link, a `+ Add class` link to `/class/new`, root `data-layout-anchor="header"`; `ScheduleHeaderSkeleton`'s root has the same class set and anchor, no `a` and no `h1`, and an `AvatarSkeleton` of the same size (`[style*="width: 40px"]`). Add to `avatar.test.tsx`: `AvatarSkeleton` renders `aria-hidden`, `rounded-pill`, `shrink-0`, `bg-sand-soft`, and `width`/`height` equal to `size`.

- [ ] **Step 2: Run and see them fail** (`--project components` on the three files).

- [ ] **Step 3: Implement `page-header.tsx`:**

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';

type HeaderVariant = 'display' | 'title';

interface PageHeaderProps {
  title: string;
  /** Back-link target. Pass null on tab pages — the tab bar is the way back. */
  backHref?: string | null;
  backLabel?: string;
  /** 'display' for tab pages (28, teal), 'title' for detail pages (22, teal). */
  variant?: HeaderVariant;
  action?: ReactNode;
}

const TITLE_STYLE: Record<HeaderVariant, 'type-display' | 'type-title'> = {
  display: 'type-display',
  title: 'type-title',
};
const BACK_SLOT = 'inline-flex items-center gap-1.5 type-label mb-2';
const BACK_ICON_SIZE = 18;

// The header's frame, shared by the page and its skeleton.
function PageHeaderFrame({ back, title, action }: { back: ReactNode; title: ReactNode; action: ReactNode }) {
  return (
    <div className="mb-6" data-layout-anchor="header">
      {back}
      <div className="flex items-center justify-between gap-3">
        {title}
        {action}
      </div>
    </div>
  );
}

export function PageHeader({ title, backHref = '/schedule', backLabel = 'Schedule', variant = 'title', action }: PageHeaderProps) {
  return (
    <PageHeaderFrame
      back={backHref !== null && (
        <Link href={backHref} className={`${BACK_SLOT} text-teal no-underline`}>
          <Icon name="arrow-left" size={BACK_ICON_SIZE} />
          {backLabel}
        </Link>
      )}
      title={<h1 className={TITLE_STYLE[variant]}>{title}</h1>}
      action={action}
    />
  );
}

interface PageHeaderSkeletonProps {
  /** Only whether it is null matters: null draws no back-link slot. */
  backHref?: string | null;
  variant?: HeaderVariant;
  action?: boolean;
}

export function PageHeaderSkeleton({ backHref = '/schedule', variant = 'title', action = false }: PageHeaderSkeletonProps) {
  return (
    <PageHeaderFrame
      back={backHref !== null && (
        <span aria-hidden="true" className={BACK_SLOT}>
          <span className="shrink-0" style={{ width: BACK_ICON_SIZE, height: BACK_ICON_SIZE }}>
            <Skeleton className="w-full h-full" />
          </span>
          <SkeletonText type="type-label" width="w-20" />
        </span>
      )}
      title={<SkeletonText type={TITLE_STYLE[variant]} width="w-40" />}
      action={action ? <SkeletonText type="type-label" width="w-24" /> : undefined}
    />
  );
}
```

The back-slot icon placeholder takes its size from `BACK_ICON_SIZE`, the constant the real `Icon` uses. The class set of the real `Link` is `BACK_SLOT` + `text-teal no-underline`, equal to today's string; the outer `div`'s set is `mb-6` (+ the new data attribute only).

Avatar: extract the shared frame tokens `shrink-0 rounded-pill` into a module constant used by both `Avatar` branches and `AvatarSkeleton`:

```tsx
export function AvatarSkeleton({ size }: { size: number }) {
  return <span aria-hidden="true" style={{ width: size, height: size }} className={`inline-block ${AVATAR_FRAME} bg-sand-soft`} />;
}
```

`schedule-header.tsx`: move the header block from `schedule/page.tsx` verbatim into `ScheduleHeaderFrame({ avatar, title, caption, action })` whose root is `<div className="flex items-center justify-between gap-3 mb-6" data-layout-anchor="header">`, inner `<div className="flex items-center gap-3 min-w-0">{avatar}<div>{title}{caption}</div></div>{action}`. `ScheduleHeader` passes the existing `Link` + `Avatar` (size `SCHEDULE_AVATAR_SIZE = 40`), `<h1 className="type-display">Schedule</h1>`, `<p className="type-caption mt-1">{today}</p>`, and the `+ Add class` `Link` with its exact classes. `ScheduleHeaderSkeleton` passes `<span className="shrink-0"><AvatarSkeleton size={SCHEDULE_AVATAR_SIZE} /></span>`, `<SkeletonText type="type-display" width="w-36" />`, `<SkeletonText type="type-caption" width="w-28" className="mt-1" />`, `<SkeletonText type="type-label" width="w-20" className="shrink-0" />`. The page computes `today` as it does now (`formatDayHeader(startOfLocalDay(now, session.defaultTimezone))`) and renders `<ScheduleHeader firstName=… lastName=… photoId={teacher.photo?.id ?? null} today={…} />`.

- [ ] **Step 4: Run the component tests, `tsc --noEmit`, eslint on touched files.** Expected: PASS. Record each changed element's before/after class set.

- [ ] **Step 5: Prove the frame pins bite.** In `PageHeaderSkeleton`, replace `PageHeaderFrame` with a hand-written `<div className="mb-5">…` → the first test goes red; restore. In `ScheduleHeaderSkeleton`, drop `mb-6` from the frame only for the skeleton path (temporarily inline a copy) → red; restore. Record the failure text.

- [ ] **Step 6: Commit** — `feat(layout): PageHeader and the schedule header draw their skeletons through their own frames (#740)`.

---

### Task 3: Cards and the schedule list own their skeletons

**Files:**
- Modify: `src/components/ui/card.tsx`; Create: `src/components/ui/card.test.tsx`
- Modify: `src/components/ui/status-badge.tsx` (+ `StatusBadgeSkeleton`), `src/components/ui/registration-progress.tsx` (+ `RegistrationProgressSkeleton`), with tests beside them
- Create: `src/components/schedule/class-card.tsx`, `src/components/schedule/class-card.test.tsx`
- Modify: `src/components/schedule/class-list.tsx` (import the cards; add `ClassListSkeleton`), `src/components/schedule/class-list.test.tsx` if it imports the moved internals

**Interfaces:**
- Consumes: `SkeletonText`, `Skeleton`, `SkeletonSurface` (T1).
- Produces:
```ts
export function Card(props: { children: ReactNode; className?: string; href?: string }): JSX.Element; // href → Link
export function StatusBadgeSkeleton(props: { surface?: SkeletonSurface }): JSX.Element;
export function RegistrationProgressSkeleton(props: { className?: string; surface?: SkeletonSurface }): JSX.Element;
export type ClassWithDetails; export type StudioClassWithEntry;          // moved to class-card.tsx
export function ClassCard(props: { cls: ClassWithDetails; isPast: boolean }): JSX.Element;
export function ClassCardSkeleton(): JSX.Element;
export function StudioClassCard(props: { sc: StudioClassWithEntry; isPast: boolean }): JSX.Element;
export function StudioClassCardSkeleton(): JSX.Element;
export function ClassListSkeleton(props: { cards?: number }): JSX.Element;
```

- [ ] **Step 1: Failing tests.**
  - `card.test.tsx`: `Card` without `href` is a `div` with set `bg-sand-soft border border-border rounded-card p-5`; with `href` a link with set `block bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand` (+ any `className`); `CardLink`'s set is unchanged from today (`flex items-center gap-3 bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand`).
  - `status-badge`/`registration-progress` tests: the skeleton shares the real element's frame tokens (badge: `inline-block border rounded-field px-2.5 py-[3px] text-[13px] font-medium leading-[1.4] whitespace-nowrap`; progress: the `flex items-baseline justify-end gap-[5px] mb-1` count row and the `relative h-2 rounded-[4px]` track), is `aria-hidden`, and uses `bg-sand` with `surface="card"`.
  - `class-card.test.tsx`: `ClassCard` for an open class renders a link to `/class/<id>` whose class set is `block bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand`, and with `opacity-70` for a cancelled one; `ClassCardSkeleton`'s root set equals `Card`'s plain set, it contains no link and no text (every child is `aria-hidden`), and its bars are `bg-sand`; `StudioClassCard`'s link set is `block border border-dashed border-border rounded-card px-5 py-3 no-underline hover:bg-sand-soft`; `StudioClassCardSkeleton`'s root carries `border border-dashed border-border rounded-card px-5 py-3` and no link. Reuse the fixture builders already in `class-list.test.tsx` (read it first).
  - `ClassListSkeleton` (in `class-list.test.tsx`): renders one `section` with a `type-subtitle mb-3` placeholder and `cards` (default 3) `ClassCardSkeleton`s inside a `flex flex-col gap-3` container.

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement.**
  - `card.tsx`: a module constant `CARD_SURFACE = 'bg-sand-soft border border-border rounded-card p-5'` used by `Card` (both branches) and `CardLink`; `Card` with `href` renders `<Link href={href} className={\`block ${CARD_SURFACE} no-underline hover:bg-sand ${className}\`.trim()}>`.
  - Badge/progress: hoist each frame string into a module constant used by the real component and its skeleton. Badge skeleton content: the text `Upcoming` with `text-transparent border-transparent` + the surface background, so its width and height are a real badge's. Progress skeleton: count row with transparent `0` / `/ 0–0` spans (same classes as the real ones), track with the surface background instead of `bg-border`.
  - `class-card.tsx`: move `ClassWithDetails`, `StudioClassWithEntry`, `RowState`, `deriveClassRowState`, `PaymentRollup`, `ClassCard`, `StudioClassCard` out of `class-list.tsx` unchanged in behaviour. Give each card an inner-layout frame used by the card and its skeleton:

```tsx
const CHEVRON_SIZE = 20;

// The class card's inner layout: when + badge, title + chevron, caption, bar.
function ClassCardBody({ when, badge, title, chevron, caption, progress }: {
  when: ReactNode; badge: ReactNode; title: ReactNode; chevron: ReactNode; caption: ReactNode; progress: ReactNode;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">{when}{badge}</div>
      <div className="flex items-center gap-3 mt-1">{title}{chevron}</div>
      {caption}
      {progress}
    </>
  );
}
```

  `ClassCard` = `<Card href={\`/class/${cls.id}\`} className={past || cancelled ? 'opacity-70' : ''}>` around `ClassCardBody` with today's elements (the `type-caption mt-0.5` `<p>`, `RegistrationProgress className="mt-3"` when shown, `<Icon … size={CHEVRON_SIZE} …>`). `ClassCardSkeleton` = `<Card>` (the plain `div`, so its root class set is `Card`'s) around `ClassCardBody` with `SkeletonText` (`type-label` `w-32` — a flex item, so a fixed width; `type-subtitle` `w-1/2` + `flex-1 min-w-0`; `type-caption` `w-1/3` + `mt-0.5`), `StatusBadgeSkeleton`, a `CHEVRON_SIZE` empty square, and `RegistrationProgressSkeleton className="mt-3"`, all `surface="card"`. Every placeholder is already `aria-hidden`, and the `loading.tsx` root carries `aria-busy`, so the `Card` itself needs no new prop.
  - `StudioClassCard`: same pattern, with a module constant for the dashed frame (`border border-dashed border-border rounded-card px-5 py-3`); the real link adds `block no-underline hover:bg-sand-soft` (+ `opacity-70`), the skeleton is a `div` with the frame only; bars use `surface="page"` (the dashed card sits on cream).
  - `class-list.tsx`: import the cards; hoist `WEEK_HEADING_GAP = 'mb-3'` and `WEEK_ITEMS = 'flex flex-col gap-3'` and use them in the real `h2`/`div`; add:

```tsx
export function ClassListSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div aria-hidden="true">
      <section>
        <SkeletonText type="type-subtitle" width="w-1/4" className={WEEK_HEADING_GAP} />
        <div className={WEEK_ITEMS}>
          {Array.from({ length: cards }, (_, i) => <ClassCardSkeleton key={i} />)}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run** the new tests, `pnpm exec vitest run --project components src/components/schedule src/components/ui`, `tsc --noEmit`, eslint on touched files. Expected: PASS. Record each real element's before/after class set (`ClassCard` link, `StudioClassCard` link, `CardLink`, badge, progress, week `h2`/`div`).

- [ ] **Step 5: Prove a pin bites:** change `CARD_SURFACE`'s `p-5` to `p-4` → the `ClassCard` set test is red and `ClassCardSkeleton`'s equality test stays green (both moved together — this is the point); now hand-write `ClassCardSkeleton`'s root as `<div className="bg-sand-soft border border-border rounded-card p-5">` while `CARD_SURFACE` is `p-4` → the skeleton equality test goes red. Restore both. Record the failure text.

- [ ] **Step 6: Commit** — `feat(schedule): ClassCard sits on Card; the cards, badge, bar and week list each own their skeleton (#740)`.

---

### Task 4: Every route's loading state is a recorded choice

**Files:**
- Move (with `git mv`): `src/app/(teacher)/{schedule,students,inbox,settings}/page.tsx` → `…/(overview)/page.tsx`; `src/app/(teacher)/class/[id]/page.tsx` → `src/app/(teacher)/class/[id]/(overview)/page.tsx`. Fix any relative import the move breaks.
- Delete: `src/app/(teacher)/students/loading.tsx`, `src/app/(teacher)/inbox/loading.tsx`.
- Rewrite: `src/app/(teacher)/loading.tsx`.
- Create: `src/app/(teacher)/{schedule,students,inbox,settings}/(overview)/loading.tsx`, `src/app/(teacher)/class/[id]/(overview)/loading.tsx`.
- Modify: `src/components/ui/input.tsx` (+ `InputSkeleton`), `src/components/class/send-announcement.tsx` (+ `SendAnnouncementSkeleton`), `src/components/students/student-directory.tsx` (+ `StudentDirectorySkeleton`), `src/components/layout/notification-list.tsx` (+ `NotificationListSkeleton`), the `ClassInfo` component file (+ `ClassInfoSkeleton`; find it from the class page's import) — each with a test beside it pinning frame-sharing as in T1–T3.
- Modify: `src/lib/visual-baseline-freshness.ts` (`ROUTE_BASELINES` source paths for the moved pages).
- Modify: comments naming the moved class page path — `src/components/class/pricing-preview.tsx`, `src/components/class/attendance-list.test.tsx`, `src/components/class/add-walk-in.test.tsx`, `src/services/invitations.ts`, `tests/integration/invitations-api.test.ts` — and re-run `grep -rn -e '(teacher)/schedule/page' -e '(teacher)/students/page' -e '(teacher)/inbox/page' -e '(teacher)/settings/page' -e '(teacher)/class/\[id\]/page' src tests docs --include='*' | grep -v docs/superpowers` until empty. (`docs/superpowers/` holds dated records; leave them.)
- Create: `src/lib/loading-coverage.test.ts`.

**Interfaces — Consumes:** `PageHeaderSkeleton`, `ScheduleHeaderSkeleton` (T2); `ClassListSkeleton` (T3); `ListRowSkeleton`, `listRowClass` (T1).

- [ ] **Step 1: Write the failing coverage test** `src/lib/loading-coverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(__dirname, '../app');

/**
 * 'group': the route deliberately shows its route group's neutral fallback.
 * 'none': no loading.tsx covers it; the previous page stays until it is ready.
 */
type FallbackKind = 'group' | 'none';

// Every page.tsx without a loading.tsx in its own segment, and the fallback
// it relies on. A new page fails the first test below until it gets its own
// loading.tsx or an entry here (docs/design-brief.md, Loading states).
const FALLBACK_ROUTES: Readonly<Record<string, FallbackKind>> = {
  '(public)': 'none',
  '(public)/[slug]': 'none',
  '(public)/[slug]/book/[classId]': 'none',
  '(public)/login': 'none',
  '(public)/signup': 'none',
  '(public)/signup/profile': 'none',
  '(public)/start': 'none',
  '(public)/verify': 'none',
  '(student)/account': 'none',
  '(student)/account/data': 'none',
  '(student)/account/notifications': 'none',
  '(student)/account/privacy': 'none',
  '(student)/account/tier': 'none',
  '(student)/bookings': 'none',
  '(student)/updates': 'none',
  '(teacher)/class/[id]/edit': 'group',
  '(teacher)/class/new': 'group',
  '(teacher)/inbox/invitations': 'group',
  '(teacher)/schedule/past': 'group',
  '(teacher)/settings/notifications': 'group',
  '(teacher)/settings/payments': 'group',
  '(teacher)/settings/profile': 'group',
  '(teacher)/settings/recurring': 'group',
  '(teacher)/settings/recurring/[id]': 'group',
  '(teacher)/settings/recurring/archived': 'group',
  '(teacher)/settings/recurring/new': 'group',
  '(teacher)/settings/reporting': 'group',
  '(teacher)/settings/rooms': 'group',
  '(teacher)/settings/rooms/[id]': 'group',
  '(teacher)/settings/rooms/archived': 'group',
  '(teacher)/settings/rooms/new': 'group',
  '(teacher)/settings/studio-classes': 'group',
  '(teacher)/settings/studio-classes/[id]': 'group',
  '(teacher)/settings/studio-classes/archived': 'group',
  '(teacher)/settings/studio-classes/new': 'group',
  '(teacher)/students/[id]': 'group',
  '(teacher)/students/archived': 'group',
  '(teacher)/students/contacts/[id]': 'group',
  '(teacher)/students/contacts/archived': 'group',
  '(teacher)/students/new': 'group',
  '(teacher)/studio-class/[id]': 'group',
  '(teacher)/studio-class/[id]/edit': 'group',
  '(teacher)/studio-class/new': 'group',
};

const toKey = (dir: string) => path.relative(APP, dir).split(path.sep).join('/');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

const all = files(APP);
const pages = all.filter((f) => path.basename(f) === 'page.tsx').map((f) => toKey(path.dirname(f)));
const loadings = all.filter((f) => path.basename(f) === 'loading.tsx');

const ownLoading = (key: string) => existsSync(path.join(APP, key, 'loading.tsx'));

/** The segment whose loading.tsx would wrap this page, or null: closest first, as Next resolves it. */
function closestLoading(key: string): string | null {
  const segments = key === '' ? [] : key.split('/');
  for (let n = segments.length; n >= 0; n--) {
    const candidate = segments.slice(0, n).join('/');
    if (ownLoading(candidate)) return candidate;
  }
  return null;
}

const routeGroup = (key: string) => (/^\(.+\)$/.test(key.split('/')[0] ?? '') ? key.split('/')[0] ?? null : null);

describe('every route\'s loading state is chosen', () => {
  it('each page has its own loading.tsx or a FALLBACK_ROUTES entry', () => {
    const unchosen = pages.filter((key) => !ownLoading(key) && !(key in FALLBACK_ROUTES));
    expect(unchosen).toEqual([]);
  });

  it('a group entry is actually covered by its route group\'s fallback, not a sibling\'s skeleton', () => {
    const wrong = Object.entries(FALLBACK_ROUTES)
      .filter(([, kind]) => kind === 'group')
      .flatMap(([key]) => {
        const covering = closestLoading(key);
        const group = routeGroup(key);
        return covering !== null && covering === group ? [] : [`${key} is covered by ${covering ?? 'nothing'}`];
      });
    expect(wrong).toEqual([]);
  });

  it('a none entry has no loading.tsx above it', () => {
    const covered = Object.entries(FALLBACK_ROUTES)
      .filter(([, kind]) => kind === 'none')
      .flatMap(([key]) => {
        const covering = closestLoading(key);
        return covering === null ? [] : [`${key} is covered by ${covering}`];
      });
    expect(covered).toEqual([]);
  });

  it('names no page that does not exist, and none that has its own loading.tsx', () => {
    const stale = Object.keys(FALLBACK_ROUTES).filter((key) => !pages.includes(key));
    const redundant = Object.keys(FALLBACK_ROUTES).filter((key) => pages.includes(key) && ownLoading(key));
    expect({ stale, redundant }).toEqual({ stale: [], redundant: [] });
  });

  it('no loading.tsx draws a shape by hand from the raw Skeleton', () => {
    const raw = loadings
      .filter((file) => readFileSync(file, 'utf8').includes('@/components/ui/skeleton'))
      .map((file) => toKey(path.dirname(file)));
    expect(raw).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it** — `pnpm exec vitest run --project unit src/lib/loading-coverage.test.ts`. Expected: FAIL — the tab roots have no own `loading.tsx` yet (they are not in the allowlist), and several `group` entries are covered by `students`/`inbox`/`(teacher)` boundaries in the wrong way; raw-Skeleton imports in the existing loading files.

- [ ] **Step 3: Move the five pages** with `git mv` (quote paths). Run `pnpm exec tsc --noEmit`; fix any relative import. Update `ROUTE_BASELINES` source paths and the comment references listed under Files; re-run the grep until empty. Run `pnpm exec vitest run --project unit src/lib/visual-baseline-freshness.test.ts` (or whichever test covers it — find it) — expected PASS.

- [ ] **Step 4: Add the component skeletons** — each in its component's file, sharing that component's frame through a module constant, each with a test beside it asserting the shared tokens, `aria-hidden`, and no interactive element:
  - `InputSkeleton({ className? })` in `input.tsx`: the field frame `border rounded-field px-4 min-h-12` (hoist it; `Input` keeps its full class set) with `border-border bg-sand-soft`, no label.
  - `SendAnnouncementSkeleton()` in `send-announcement.tsx`: the collapsed state is a `type-label` button, so `<SkeletonText type="type-label" width="w-36" />`.
  - `StudentDirectorySkeleton({ rows = 6 })` in `student-directory.tsx`: the directory's own `mb-4` search wrapper (hoisted constant) around `InputSkeleton`, then `rows` `ListRowSkeleton`s with the directory row's options.
  - `NotificationListSkeleton({ rows = 6 })` in `notification-list.tsx`: hoist the row layout (`flex items-start justify-between gap-2 px-3 -mx-3`) into a constant used by the real rows' `listRowClass({ density: 'relaxed', divider: 'after-each', className: … })` and by the skeleton's `ListRowSkeleton` rows, inside the list's own `flex flex-col` root.
  - `ClassInfoSkeleton()` beside `ClassInfo`: its outer frame (a `Card` or whatever primitive `ClassInfo`'s root is — read it) with `SkeletonText` lines for its first rows, `surface` matching the frame.

- [ ] **Step 5: Write the loading files.** Every one is a server component wrapping its content in `<div aria-busy="true">`, importing only `*Skeleton` primitives.
  - `(teacher)/loading.tsx`:

```tsx
import { PageHeaderSkeleton } from '@/components/layout/page-header';

// The fallback for every teacher route without a loading.tsx of its own: a
// quiet header and nothing below, so an unchosen route shows something vague
// rather than another page's shape. Which routes rely on it is recorded in
// src/lib/loading-coverage.test.ts.
export default function TeacherLoading() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton />
    </div>
  );
}
```

  - `schedule/(overview)/loading.tsx`: `<ScheduleHeaderSkeleton />` then `<div data-layout-anchor="first-item"><ClassListSkeleton /></div>`.
  - `students/(overview)/loading.tsx`: `<PageHeaderSkeleton backHref={null} variant="display" action />`, `<div className="mb-5" data-layout-anchor="first-item"><SendAnnouncementSkeleton /></div>`, `<StudentDirectorySkeleton />`.
  - `inbox/(overview)/loading.tsx`: `<PageHeaderSkeleton backHref={null} variant="display" />`, `<div data-layout-anchor="first-item"><NotificationListSkeleton /></div>`.
  - `settings/(overview)/loading.tsx`: `<PageHeaderSkeleton backHref={null} variant="display" />`, `<div data-layout-anchor="first-item">` with six `<ListRowSkeleton lines={1} />`.
  - `class/[id]/(overview)/loading.tsx`: `<PageHeaderSkeleton backHref="/" />`, `<ClassInfoSkeleton />`.
  - Each tab-root page marks the same block: schedule wraps `<ClassList …>` in `<div data-layout-anchor="first-item">`; students adds the attribute to its existing `<div className="mb-5">`; inbox wraps `<NotificationList …>`; settings adds it to the row-list `<div>`. Attributes and a style-less wrapper only — no class changes.

- [ ] **Step 6: Run** the coverage test (expected PASS), the recipe tether, `--project components`, `tsc --noEmit`, eslint on touched files.

- [ ] **Step 7: Prove the coverage test bites.** For each: apply, run, record the exact failure, restore, confirm `git status --porcelain` clean of it.
  1. Create `src/app/(teacher)/zz-probe/page.tsx` (`export default function P() { return null; }`) → test 1 red naming `(teacher)/zz-probe`.
  2. Create `src/app/(teacher)/settings/loading.tsx` (a copy of the neutral fallback) → test 2 red, listing every `(teacher)/settings/…` group entry as "is covered by (teacher)/settings" — the wrong-page inheritance the `(overview)` move exists to prevent.
  3. Change `'(student)/bookings'` to `'group'` → test 2 red ("covered by nothing").
  4. Add `'(teacher)/gone': 'group'` → test 4 red (`stale`).
  5. Add `import { Skeleton } from '@/components/ui/skeleton';` to `inbox/(overview)/loading.tsx` → test 5 red.

- [ ] **Step 8: Smoke the routes in the running worktree app** (`:3107`): request `/schedule`, `/students`, `/inbox`, `/settings`, `/settings/profile`, `/class/<an id>`, `/class/<id>/edit`, `/schedule/past` with a teacher session (see `.claude/skills/verify/`) and confirm each answers 200 with its expected heading — the `(overview)` moves must not change any URL.

- [ ] **Step 9: Commit** — `feat(app): every route's loading state is chosen — tab roots draw their own from primitives, the rest a neutral header; a test records which (#740)`.

---

### Task 5: The geometry check

**Files:**
- Create: `tests/e2e/skeleton-hold.ts` (the in-page fetch hold + prefetch wait)
- Create: `tests/e2e/skeleton-geometry.spec.ts`

**Interfaces — Consumes:** the `data-layout-anchor="header"` / `"first-item"` attributes and `aria-busy="true"` roots from T2/T4.

- [ ] **Step 1: Write `tests/e2e/skeleton-hold.ts`.** It exports `installFetchHold` (passed to `page.addInitScript`), `armHold(page, pathname)`, `waitForHolding(page)`, `releaseHold(page)`, and `prefetchSettled(page, pathname)`. The body of `installFetchHold` is the spike's wrapper, verbatim in behaviour:

```ts
import type { Page, Request } from '@playwright/test';

type HoldState = 'idle' | 'armed' | 'fetching' | 'holding' | 'released';
interface Hold { target: string | null; state: HoldState; release: (() => void) | null }
type HoldWindow = Window & { __skeletonHold: Hold };

/**
 * Runs in the page. Wraps fetch so the next RSC navigation fetch to the armed
 * path is served as a stream that withholds part of its body until release:
 * under `next dev` the line holding the page's own row (its boundary then
 * suspends and loading.tsx renders); in a production build, where that dev-only
 * marker is absent, the whole body (the prefetched boundary renders). If Next
 * changes either shape, no skeleton appears and the spec fails at its
 * visibility assertion — it cannot pass by comparing the page with itself.
 */
export function installFetchHold(): void {
  const w = window as unknown as HoldWindow;
  w.__skeletonHold = { target: null, state: 'idle', release: null };
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const hold = w.__skeletonHold;
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const isNavigation =
      headers.get('rsc') === '1' && !headers.has('next-router-prefetch') && !headers.has('next-router-segment-prefetch');
    if (hold.state !== 'armed' || url.pathname !== hold.target || !isNavigation) return original(input, init);
    hold.state = 'fetching';
    const response = await original(input, init);
    const text = await response.text();
    let head = '';
    let tail = text;
    const marker = /"type":"page","pagePath":"[^"]*","children":"\$L?([0-9a-f]+)"/.exec(text);
    const row = marker && new RegExp(`(^|\\n)${marker[1]}:[\\[{"]`).exec(text);
    if (row) {
      const start = row.index + (row[1] ? 1 : 0);
      const end = text.indexOf('\n', start) + 1;
      tail = text.slice(start, end);
      head = text.slice(0, start) + text.slice(end);
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (head) controller.enqueue(encoder.encode(head));
        hold.state = 'holding';
        hold.release = () => {
          controller.enqueue(encoder.encode(tail));
          controller.close();
          hold.state = 'released';
        };
      },
    });
    const held = new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
    Object.defineProperty(held, 'url', { value: response.url });
    Object.defineProperty(held, 'redirected', { value: response.redirected });
    return held;
  };
}
```

  `armHold` sets `target` and `state = 'armed'` via `page.evaluate`; `waitForHolding` is `page.waitForFunction(() => window.__skeletonHold.state === 'holding')`; `releaseHold` calls `release()`. `prefetchSettled(page, pathname)` must be called **before** `page.goto` and returns a promise resolving on `requestfinished` **or** `requestfailed` of a request to `pathname` with header `next-router-prefetch: 1` and without `next-router-segment-prefetch` (that prefetch usually ends `net::ERR_ABORTED` even when it worked). Dev vs prod: `await page.locator('nextjs-portal').count() > 0` means dev, where no prefetch happens — skip the wait there.

- [ ] **Step 2: Write `tests/e2e/skeleton-geometry.spec.ts`.** Follow `visual.spec.ts`'s fixture pattern (`test` from `./fixtures`, `PrismaClient`, `uniqueSuffix`, `seedSession`, `sessionCookie`, `accountIdOfTeacher`, `createClassFixture`; `test.describe.configure({ mode: 'serial' })`; teardown inside `afterAll` guarded so an undefined id never reaches a `deleteMany` filter). The teacher has a `bio`, a `bankIban`, a room and one class this week, and `skippedOnboarding` set so that neither `GettingStarted` nor `InstallCard` renders — read `src/lib/onboarding.ts` (`isOnboardingComplete`) and `install-card.tsx` for the exact values. Seed one notification for it. Use `wallSlotAt(..., 'UTC')`-style UTC fixtures for any real-time date (see `tests/class-fixtures.ts`).

  One test per tab root, driven by a table:

```ts
const ROUTES = [
  { path: '/students', tab: 'Students', from: '/schedule' },
  { path: '/inbox', tab: 'Inbox', from: '/schedule' },
  { path: '/settings', tab: 'Settings', from: '/schedule' },
  { path: '/schedule', tab: 'Schedule', from: '/inbox' },
] as const;
const TOLERANCE_PX = 2;
```

  Each test: `addInitScript(installFetchHold)`; `const prefetched = prefetchSettled(page, path)`; `goto(from)`; wait for `hydrationSignal`; if prod, `await prefetched`; `armHold(page, path)`; click `page.locator('nav').getByRole('link', { name: tab, exact: true })`; `waitForHolding`; **assert `page.locator('[aria-busy="true"]')` is visible**; read `boundingBox()` of `[aria-busy="true"] [data-layout-anchor="header"]` and `[aria-busy="true"] [data-layout-anchor="first-item"]`; `releaseHold`; `waitForURL(path)`; wait until `[aria-busy="true"]` has count 0; read the same two anchors from the page; assert `|Δy|` of header, `|Δheight|` of header, and `|Δy|` of first-item are each `<= TOLERANCE_PX`, with a message naming the route and both numbers.

  A short comment at the top of the spec states what it does not cover: only the header and the first block below it are compared; conditional blocks (`GettingStarted`, `InstallCard`) are absent in its fixture by construction; later rows' heights are cosmetic.

- [ ] **Step 3: Run it against the worktree dev server** — `pnpm exec playwright test skeleton-geometry` (reads `INTEGRATION_BASE_URL`). Expected: PASS on both projects. If a route fails on geometry, the skeleton is wrong — fix the skeleton composition in its `loading.tsx` / primitive skeleton (never widen the tolerance) and record what moved and why.

- [ ] **Step 4: Run it against a production build.** `pnpm run build`; start the standalone server the way `.github/workflows/ci.yml`'s `test-e2e` job does (copy `.next-build/static` and `public`), on a free port (e.g. 3197) with this worktree's `.env`; run with `INTEGRATION_BASE_URL=http://127.0.0.1:3197`. Expected: PASS. Stop that server.

- [ ] **Step 5: Prove it bites.** (a) In `students/(overview)/loading.tsx` drop `action` from `PageHeaderSkeleton` and remove the `mb-5` wrapper class → the students test fails on first-item or header. (b) Make `armHold` target a path no click goes to → the test fails at `waitForHolding`/visibility, not at geometry. Restore; record both failure texts.

- [ ] **Step 6: Commit** — `test(e2e): skeleton and page agree on header and first-item geometry on the four tab roots (#740)`.

---

### Task 6: Document the rule, attest the renders, verify

**Files:**
- Modify: `docs/design-brief.md` (a "Loading states" section; the Skeleton bullet at the components list points to it)
- Modify: `tests/e2e/visual-baseline-attestations.json` (via the attest script only)

- [ ] **Step 1: Write the "Loading states" section** in `docs/design-brief.md`, near the components/patterns section that today says "Skeleton — static sand blocks matching layout". State: static sand, no shimmer; a skeleton is its primitive's frame with placeholder content — `XSkeleton` beside `X`, built through the same frame, and `SkeletonText` taking a line's height from its type style; the raw `Skeleton` is a content placeholder only, and no `loading.tsx` imports it (enforced); bars on a card use `surface="card"`; every route's loading state is a recorded choice — its own `loading.tsx`, the `(teacher)` group's neutral header, or none — kept in `FALLBACK_ROUTES` in `src/lib/loading-coverage.test.ts`; a tab root's own skeleton lives with its page in an `(overview)` route group so it covers that page alone; the row recipe's owner and exceptions are in `src/lib/list-row-recipe.test.ts`; the four tab roots' header and first-item geometry is checked by `tests/e2e/skeleton-geometry.spec.ts`. Update the existing Skeleton bullet to match.

- [ ] **Step 2: Attest the visual baselines.** `pnpm run check-visual-baseline-freshness` lists the routes this branch touched without new baselines. For each listed route, run `pnpm run attest-visual-baseline <route>` (it runs the visual suite and refuses if any screenshot differs). Expected: each attests. If one does not, the extraction changed a real page — find the class-set difference, fix it, re-run; never regenerate a baseline to make it pass.

- [ ] **Step 3: Full verification.** `pnpm run verify` (typecheck, lint, every vitest project; needs the worktree app up). Then `pnpm exec playwright test` for the whole e2e suite against the worktree dev server. Record totals.

- [ ] **Step 4: Commit** — `docs(design): loading states compose primitives and every route's choice is recorded; visual baselines attested unchanged (#740)`.
