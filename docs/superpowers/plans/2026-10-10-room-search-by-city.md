# Room Search by City Implementation Plan (#805)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The add-room flow searches shared rooms by city (accent- and case-insensitive, starts-with, optional street/venue narrowing), and the create form no longer inherits a bare street name as the room's address.

**Architecture:** A new `GET /api/rooms?city=…&q=…` branch calls a framework-agnostic service that runs one raw id query (needed for `unaccent`) and then loads rows through the existing `ROOM_SEARCH_SELECT` tether. The existing `postcode+street` branch is untouched — `share-room-button.tsx` still uses it as an exact-address duplicate check. On the client, `AddRoomFlow` shares `city`/`q` between steps instead of `postcode`/`street`; address and postcode move into the router-owned `NewRoomForm`.

**Tech Stack:** Next.js 16 route handler, Prisma (`$queryRaw`), PostgreSQL 16 `unaccent` contrib extension, React client components, Vitest (unit / components / integration), Playwright.

**Spec:** None — bounded change, design agreed in session and recorded in issue #805. The design decisions this plan argues from:
- City match: **starts-with**, case-insensitive, **accent-insensitive** (`Zurich` finds `Zürich`, `Malmo` finds `Malmö`, `Strasse` finds `Straße`).
- Optional `q`: **contains**, same folding, on `address` OR `venueName`.
- Results capped at **50**, ordered by venue name; the response says whether more exist.
- Create form: city carried over from the search when the form's city is empty; address and postcode start empty; Address placeholder `e.g. Keizersgracht 123`; a **non-blocking** hint `Did you include the house number?` when the address contains no digit.

## Global Constraints

- TypeScript `strict`; no `any`.
- Services take `db: PrismaClient` as their first parameter and import nothing from `next` (pattern: `src/services/room-archive.ts`).
- Migration via `pnpm exec prisma migrate dev --name unaccent_extension --create-only`, then hand-write its SQL; never edit an applied migration (comments included).
- The wire shape of shared rooms is `RoomResult` and nothing more — rows must be loaded with `ROOM_SEARCH_SELECT` (`src/app/api/rooms/route.ts`), never with a hand-written column list in SQL (#768).
- Comment discipline (CLAUDE.md): comments annotate their own code; no prose counts or rosters.
- Copy: calm, plain. Exact strings are given in the tasks; use them verbatim.
- Stage exact paths; quote paths containing parentheses.
- In this worktree, run `pnpm run worktree:up` before any `--project integration` or Playwright run.

## Review Focus

1. **A user typing `%` or `_`** (e.g. a venue called `Studio_1`) — must match literally, not act as a wildcard. Test in Task 1.
2. **A city typed with surrounding spaces or different case** (`  amsterdam `) — must match `Amsterdam`. Test in Task 1.
3. **A `city` param that is empty or whitespace-only** — must not fall through to the default "all rooms" listing as if it were a search; answers 400. Test in Task 1.
4. **Going Back from the create step to search and forward again** — the city typed in the create form, and the address/postcode, must survive (they live in the router-owned form). Test in Task 2.
5. **The share-button duplicate check** — still sends `postcode` + `street` and still gets a bare `RoomResult[]`. Existing tests `src/components/settings/share-room-button.test.tsx` and `tests/integration/rooms-search-api.test.ts` must pass unchanged in their assertions. Verified in both tasks' final runs.

---

### Task 1: Server — city search endpoint

**Files:**
- Create: `prisma/migrations/<timestamp>_unaccent_extension/migration.sql`
- Create: `src/services/shared-room-search.ts`
- Modify: `src/lib/room-search.ts` (add the response type only — `import type`-safe, no runtime imports)
- Modify: `src/lib/schemas.ts:539-542` (`roomSearchQuerySchema`)
- Modify: `src/app/api/rooms/route.ts` (GET: new branch before the `postcode && street` branch; export `ROOM_SEARCH_SELECT`, or move it — see Step 5)
- Test: `tests/integration/rooms-city-search-api.test.ts` (new file; leave `rooms-search-api.test.ts` alone)

**Interfaces:**
- Produces (in `src/lib/room-search.ts`):
  ```ts
  export const ROOM_CITY_SEARCH_LIMIT = 50;
  export interface RoomCitySearchResult {
    rooms: RoomResult[];
    /** True when more rooms matched than `ROOM_CITY_SEARCH_LIMIT`. */
    truncated: boolean;
  }
  ```
- Produces (in `src/services/shared-room-search.ts`):
  ```ts
  export async function searchSharedRoomsByCity(
    db: PrismaClient,
    input: { city: string; q?: string },
  ): Promise<RoomCitySearchResult>
  ```
- Produces (wire): `GET /api/rooms?city=<c>[&q=<q>]` → `200 { data: RoomCitySearchResult }`; whitespace-only `city` → `400`.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/rooms-city-search-api.test.ts` — mirror the setup of `rooms-search-api.test.ts` (same `makeTeacher`, `seedSession`, `uniqueSuffix`, cleanup by `suffix`). Cities must be unique per run so parallel runs and leftover rows can't interfere: build them from the suffix.

```ts
/**
 * GET /api/rooms?city=…&q=… — browsing shared rooms by city (#805).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
// Unique per run; the accented spelling is what is stored.
const city = `Zürich-${suffix}`;
const otherCity = `Bern-${suffix}`;

let searcherToken: string;

async function makeTeacher(tag: string): Promise<{ id: string; token: string }> {
  const email = `roomcity-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Room', lastName: tag, email,
      account: { create: { email } },
      bio: 'Room city search tests',
      pageSlug: `roomcity-${tag}-${suffix}`,
    },
  });
  return { id: teacher.id, token: await seedSession(prisma, teacher.accountId) };
}

function makeRoom(over: { venueName: string; address: string; city: string; isPublic?: boolean }, createdById: string) {
  return prisma.room.create({
    data: {
      venueName: over.venueName,
      address: `${over.address} ${suffix}`,
      city: over.city,
      postcode: '8001',
      floor: '',
      roomName: '',
      maxCapacity: 12,
      createdById,
      isPublic: over.isPublic ?? true,
    },
  });
}

function search(params: Record<string, string>) {
  return fetch(`${BASE_URL}/api/rooms?${new URLSearchParams(params)}`, { headers: cookie(searcherToken) });
}

async function venues(params: Record<string, string>): Promise<string[]> {
  const res = await search(params);
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { rooms: { venueName: string }[]; truncated: boolean } };
  return data.rooms.map((r) => r.venueName);
}

beforeAll(async () => {
  await prisma.$connect();
  searcherToken = (await makeTeacher('searcher')).token;
  const creator = await makeTeacher('creator');
  await makeRoom({ venueName: 'Bahnhof Yoga', address: 'Bahnhofstrasse 1', city }, creator.id);
  await makeRoom({ venueName: 'Altstadt Studio', address: 'Niederdorfstraße 5', city }, creator.id);
  await makeRoom({ venueName: 'Studio_1', address: 'Seestrasse 9', city }, creator.id);
  await makeRoom({ venueName: 'Hidden Room', address: 'Privatweg 2', city, isPublic: false }, creator.id);
  await makeRoom({ venueName: 'Bern Loft', address: 'Marktgasse 3', city: otherCity }, creator.id);
});

afterAll(async () => {
  await prisma.room.deleteMany({ where: { address: { contains: suffix } } });
  await prisma.teacher.deleteMany({ where: { pageSlug: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

describe('GET /api/rooms?city=', () => {
  it('lists the shared rooms in a city, by venue name, without private ones', async () => {
    expect(await venues({ city })).toEqual(['Altstadt Studio', 'Bahnhof Yoga', 'Studio_1']);
  });

  it('matches without the accent, in any case, with surrounding spaces', async () => {
    expect(await venues({ city: `  zurich-${suffix} ` })).toHaveLength(3);
  });

  it('matches a city by its start, not its middle', async () => {
    // `uniqueSuffix()` is unique per run, so "zur" alone would also match other
    // runs' rows; the prefix test uses the full stem instead.
    expect(await venues({ city: `Züri` })).toEqual(expect.arrayContaining(['Bahnhof Yoga']));
    expect(await venues({ city: `rich-${suffix}` })).toEqual([]);
  });

  it('narrows by street or venue, accent-insensitively', async () => {
    expect(await venues({ city, q: 'niederdorfstrasse' })).toEqual(['Altstadt Studio']);
    expect(await venues({ city, q: 'bahnhof yoga' })).toEqual(['Bahnhof Yoga']);
  });

  it('treats % and _ as literal characters', async () => {
    expect(await venues({ city, q: 'Studio_' })).toEqual(['Studio_1']);
    expect(await venues({ city, q: '%' })).toEqual([]);
  });

  it('returns only RoomResult columns', async () => {
    const res = await search({ city });
    const { data } = (await res.json()) as { data: { rooms: Record<string, unknown>[] } };
    expect(Object.keys(data.rooms[0] ?? {}).sort()).toEqual(
      ['address', 'city', 'floor', 'id', 'maxCapacity', 'postcode', 'roomName', 'venueName'],
    );
  });

  it('refuses a blank city instead of listing everything', async () => {
    expect((await search({ city: '   ' })).status).toBe(400);
  });
});
```

Add one more test for the cap, using its own city so it doesn't disturb the others:

```ts
it('caps the list and says more exist', async () => {
  const capCity = `Capville-${suffix}`;
  const creator = await makeTeacher('cap');
  await prisma.room.createMany({
    data: Array.from({ length: 51 }, (_, i) => ({
      venueName: `Cap ${String(i).padStart(2, '0')}`,
      address: `Capweg ${i} ${suffix}`,
      city: capCity, postcode: '1000', floor: '', roomName: '',
      maxCapacity: 10, createdById: creator.id, isPublic: true,
    })),
  });
  const res = await search({ city: capCity });
  const { data } = (await res.json()) as { data: { rooms: unknown[]; truncated: boolean } };
  expect(data.rooms).toHaveLength(50);
  expect(data.truncated).toBe(true);
});
```

Note: the prefix test's `Züri` hits rows from any concurrent or leftover run. That's why it uses `arrayContaining`, not `toEqual`.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm run worktree:up
pnpm exec vitest run --project integration tests/integration/rooms-city-search-api.test.ts
```
Expected: failures. The current GET ignores `city` and returns the default listing (a bare array), so `data.rooms` is undefined, and the blank-city case answers 200 instead of 400.

- [ ] **Step 3: Migration**

```bash
pnpm exec prisma migrate dev --name unaccent_extension --create-only
```
Write exactly this into the generated `migration.sql` (precedent: `btree_gist` in `20260825061213_schedule_rule`):

```sql
-- Accent-insensitive room search (#805): `unaccent()` folds Zürich to Zurich.
CREATE EXTENSION IF NOT EXISTS unaccent;
```
Then `pnpm exec prisma migrate dev` to apply it to the worktree's dev database. Confirm `pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` exits 0. CI runs that drift check, and Prisma ignores extensions without the `postgresqlExtensions` preview feature, which is why `btree_gist` passes.

- [ ] **Step 4: Types and query schema**

In `src/lib/room-search.ts`, add `ROOM_CITY_SEARCH_LIMIT` and `RoomCitySearchResult` exactly as in **Interfaces** (no imports added).

In `src/lib/schemas.ts`, extend `roomSearchQuerySchema`:
```ts
export const roomSearchQuerySchema = z.object({
  postcode: z.string().optional(),
  street: z.string().optional(),
  city: z.string().max(CITY_MAX).optional(),
  q: z.string().max(ROOM_ADDRESS_MAX).optional(),
});
```
(`CITY_MAX` and `ROOM_ADDRESS_MAX` are already exported from `@/lib/input-bounds`. Add them to that file's import if needed.)

- [ ] **Step 5: Service**

Move `ROOM_SEARCH_SELECT`, with its docblock, from `src/app/api/rooms/route.ts` into `src/lib/room-projection.ts` (it already holds `SHARED_ROOM_SELECT`), export it, and import it in the route. The service needs it, and a service must not import from a route file.

`src/services/shared-room-search.ts`:
```ts
import type { PrismaClient } from '@prisma/client';
import { ROOM_SEARCH_SELECT } from '@/lib/room-projection';
import { ROOM_CITY_SEARCH_LIMIT, type RoomCitySearchResult, type RoomResult } from '@/lib/room-search';

/** Escapes LIKE's metacharacters so user input matches literally (`\` is LIKE's default escape). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Shared rooms in a city, for a teacher browsing before contributing a room.
 *
 * City is a prefix match and `q` a substring match on address or venue, both
 * folded by `lower(unaccent(...))`. Prisma's `where` cannot call `unaccent`,
 * so the raw query returns ids only and the rows are loaded through
 * `ROOM_SEARCH_SELECT` — the projection that keeps other teachers' private
 * columns off the wire. The `::text` casts are required: an untyped
 * parameter leaves `unaccent(unknown)` unresolved.
 */
export async function searchSharedRoomsByCity(
  db: PrismaClient,
  input: { city: string; q?: string },
): Promise<RoomCitySearchResult> {
  const cityPrefix = `${escapeLike(input.city.trim())}%`;
  const q = input.q?.trim() ?? '';
  const qPattern = `%${escapeLike(q)}%`;

  const hits = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Room"
     WHERE "isPublic" = true
       AND lower(unaccent("city")) LIKE lower(unaccent(${cityPrefix}::text))
       AND (${q}::text = ''
            OR lower(unaccent("address")) LIKE lower(unaccent(${qPattern}::text))
            OR lower(unaccent("venueName")) LIKE lower(unaccent(${qPattern}::text)))
     ORDER BY lower(unaccent("venueName")), "id"
     LIMIT ${ROOM_CITY_SEARCH_LIMIT + 1}`;

  const truncated = hits.length > ROOM_CITY_SEARCH_LIMIT;
  const ids = hits.slice(0, ROOM_CITY_SEARCH_LIMIT).map((h) => h.id);
  const rows: RoomResult[] = await db.room.findMany({
    where: { id: { in: ids } },
    select: ROOM_SEARCH_SELECT,
  });
  // `in` does not preserve order; restore the raw query's.
  const position = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  return { rooms: rows, truncated };
}
```

- [ ] **Step 6: Route branch**

In `GET` (`src/app/api/rooms/route.ts`), destructure `city` and `q` as well, and add this **before** the `postcode && street` branch:
```ts
  if (city !== undefined) {
    if (!city.trim()) return respondError('Enter a city to search', 400);
    const result = await searchSharedRoomsByCity(prisma, { city, q });
    return respondTyped<RoomCitySearchResult>(result);
  }
```
Leave the `postcode && street` branch and the default listing exactly as they are.

- [ ] **Step 7: Run the new tests and the old search tests**

```bash
pnpm exec vitest run --project integration tests/integration/rooms-city-search-api.test.ts tests/integration/rooms-search-api.test.ts tests/integration/rooms-shared-projection-api.test.ts
```
Expected: all pass. Curl the route once first to warm `next dev`.

- [ ] **Step 8: Prove the guards bite** (break, record the exact failure, restore, re-run)

1. Remove `escapeLike(...)` from `qPattern` → the `%`/`_` test must fail. Record the assertion text.
2. Replace `select: ROOM_SEARCH_SELECT` with `select: { ...ROOM_SEARCH_SELECT, notes: true }` → the "only RoomResult columns" test must fail. `tsc` will not catch this, because a row with an extra column is still assignable to `RoomResult`, so the runtime test is the guard. Record it.
3. Drop `unaccent(` around `"city"` (keep `lower`) → the accent test must fail. Record it.
4. Remove the blank-city 400 line → the blank-city test must fail.
Restore each one and re-run Step 7 green.

- [ ] **Step 9: Commit**

```bash
git add prisma/migrations/*_unaccent_extension/migration.sql src/services/shared-room-search.ts src/lib/room-search.ts src/lib/room-projection.ts src/lib/schemas.ts src/app/api/rooms/route.ts tests/integration/rooms-city-search-api.test.ts
git commit -m "feat: search shared rooms by city, accent- and case-insensitive (#805)"
```

---

### Task 2: Client — search by city; the create form starts with an empty address

Depends on Task 1 (`RoomCitySearchResult`, `ROOM_CITY_SEARCH_LIMIT`, the wire shape).

**Files:**
- Modify: `src/lib/room-search.ts` (add `searchRoomsByCity`; refactor the shared fetch/parse so both functions reuse it)
- Modify: `src/lib/room-search.test.ts`
- Modify: `src/components/settings/room-search-step.tsx`
- Modify: `src/components/settings/add-room-flow.tsx`
- Modify: `src/components/settings/room-create-step.tsx`
- Modify: `src/components/settings/add-room-flow.test.tsx`
- Modify: `tests/e2e/teacher-journey.spec.ts:222-247`

**Interfaces:**
- Consumes: `RoomCitySearchResult`, `ROOM_CITY_SEARCH_LIMIT` from `@/lib/room-search` (Task 1).
- Produces:
  ```ts
  export type RoomCitySearchOutcome =
    | ({ ok: true } & RoomCitySearchResult)
    | { ok: false; reason: 'http' | 'network' };
  export async function searchRoomsByCity(city: string, q: string): Promise<RoomCitySearchOutcome>
  ```
  `searchPublicRooms(postcode, street)` keeps its signature and behaviour.
- `NewRoomForm` gains `address: string` and `postcode: string` (both `''` in `EMPTY_ROOM_FORM`).
- `RoomSearchStep` props become: `city`, `q`, `results: RoomCitySearchResult | null`, `onResultsChange`, `onCityChange`, `onQChange`, `onSelect`, `onCreateNew`.
- `RoomCreateStep` props lose `postcode`, `street`, `onPostcodeChange`, `onStreetChange`.

- [ ] **Step 1: Failing unit tests for `searchRoomsByCity`** (in `src/lib/room-search.test.ts`, alongside the existing `searchPublicRooms` describe, reusing that file's fetch stubbing)

```ts
describe('searchRoomsByCity', () => {
  it('asks for the trimmed city and q', async () => {
    stubFetchOk({ data: { rooms: [], truncated: false } });
    await searchRoomsByCity('  Zürich ', '  Bahnhof ');
    const [url] = vi.mocked(global.fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe('/api/rooms?city=Z%C3%BCrich&q=Bahnhof');
  });

  it('leaves q off when it is blank', async () => {
    stubFetchOk({ data: { rooms: [], truncated: false } });
    await searchRoomsByCity('Utrecht', '   ');
    const [url] = vi.mocked(global.fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe('/api/rooms?city=Utrecht');
  });

  it('returns rooms and truncated', async () => {
    const room = { id: 'r', venueName: 'V', roomName: '', address: 'A 1', city: 'C', postcode: 'P', floor: '', maxCapacity: 5 };
    stubFetchOk({ data: { rooms: [room], truncated: true } });
    expect(await searchRoomsByCity('C', '')).toEqual({ ok: true, rooms: [room], truncated: true });
  });

  it('reports http on a refusal and network on a malformed body', async () => {
    stubFetchStatus(400);
    expect(await searchRoomsByCity('C', '')).toEqual({ ok: false, reason: 'http' });
    stubFetchOk({ data: [] }); // the old bare-array shape is not this endpoint's
    expect(await searchRoomsByCity('C', '')).toEqual({ ok: false, reason: 'network' });
  });
});
```
(If the file doesn't already have `stubFetchOk`/`stubFetchStatus`-style helpers, write them at the top in that file's existing stubbing idiom.)

Run `pnpm exec vitest run src/lib/room-search.test.ts`. Expected: FAIL, `searchRoomsByCity` is not exported.

- [ ] **Step 2: Implement `searchRoomsByCity`**

Pull the request-and-parse part of `searchPublicRooms` (fetch → `'network'`; `!res.ok` → `'http'`; `res.json()` throw → `'network'`) into a private `fetchRoomSearch(params: URLSearchParams, logTag: string): Promise<{ ok: true; body: unknown } | { ok: false; reason: 'http' | 'network' }>`. `searchPublicRooms` keeps its log tags (`room-search-request`, `room-search-body`) and runs `readRoomResults` on the body. Add `readRoomCitySearch(body: unknown): RoomCitySearchResult | null`, which checks that `data` is an object whose `rooms` passes the same per-room check `readRoomResults` applies (factor that per-room predicate out) and whose `truncated` is a boolean. `searchRoomsByCity` builds params with `city` always set and `q` only when its trim is non-empty, and logs under `room-city-search-request` / `room-city-search-body`.

Run the unit file again. Expected: PASS, including every pre-existing `searchPublicRooms` test unchanged.

- [ ] **Step 3: Rewrite the component tests first**

In `src/components/settings/add-room-flow.test.tsx`:

a) Add a helper at the top of the `describe` and replace **every** Postcode+Street+Search sequence in the file with it (there are several; find them all with `grep -n "getByLabelText('Street')" src/components/settings/add-room-flow.test.tsx`):
```ts
async function searchCity(city = 'Amsterdam') {
  fireEvent.change(screen.getByLabelText('City'), { target: { value: city } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText(/no shared rooms found/i);
}
```
(The failure-path tests that expect an error message instead of results shouldn't await the "no shared rooms" text. Inline the two `fireEvent` lines there.)

b) Every `/api/rooms?` stub that returns `{ data: [] }` now returns `{ data: { rooms: [], truncated: false } }`.

c) Every test that reaches **Create room** and expects a POST must now fill `Address` and `Postcode` in the create step, because they no longer arrive from the search. In the first test (`sends both bodies`), keep the explicit fills it already has.

d) Replace `asks the search endpoint for the typed postcode and street` with:
```ts
it('asks the search endpoint for the typed city and street-or-venue', async () => {
  stubFetch();
  render(<AddRoomFlow currency="EUR" />);
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Amsterdam' } });
  fireEvent.change(screen.getByLabelText(/Street or venue/), { target: { value: 'Keizersgracht' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText(/no shared rooms found/i);
  const [url] = fetchMock.mock.calls[0] ?? [];
  expect(String(url)).toBe('/api/rooms?city=Amsterdam&q=Keizersgracht');
});
```

e) New tests:
```ts
it('carries the city into the create form and leaves the address empty', async () => {
  stubFetch();
  render(<AddRoomFlow currency="EUR" />);
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Amsterdam' } });
  fireEvent.change(screen.getByLabelText(/Street or venue/), { target: { value: 'Keizersgracht' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText(/no shared rooms found/i);
  fireEvent.click(screen.getByRole('button', { name: 'Create new room' }));

  expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Amsterdam');
  const address = screen.getByLabelText('Address') as HTMLInputElement;
  expect(address.value).toBe('');
  expect(address.placeholder).toBe('e.g. Keizersgracht 123');
  expect((screen.getByLabelText('Postcode') as HTMLInputElement).value).toBe('');
});

it('hints at a missing house number without blocking the create', async () => {
  stubFetch();
  render(<AddRoomFlow currency="EUR" />);
  await searchCity();
  fireEvent.click(screen.getByRole('button', { name: 'Create new room' }));

  fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Keizersgracht' } });
  expect(screen.getByText('Did you include the house number?')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Keizersgracht 1' } });
  expect(screen.queryByText('Did you include the house number?')).toBeNull();

  fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Keizersgracht' } });
  fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'De Studio' } });
  fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '1018 DT' } });
  fireEvent.change(screen.getByLabelText('Max capacity'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  const [, opts] = fetchMock.mock.calls[1] ?? [];
  expect(JSON.parse((opts as { body: string }).body).address).toBe('Keizersgracht');
});

it('asks for address and postcode before posting', async () => {
  stubFetch();
  render(<AddRoomFlow currency="EUR" />);
  await searchCity();
  fireEvent.click(screen.getByRole('button', { name: 'Create new room' }));
  fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'De Studio' } });
  fireEvent.change(screen.getByLabelText('Max capacity'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
  expect(await screen.findByText('Venue name, address, city and postcode are required')).toBeInTheDocument();
  expect(fetchMock.mock.calls).toHaveLength(1);
});

it('keeps the create form across Back and forward again', async () => {
  stubFetch();
  render(<AddRoomFlow currency="EUR" />);
  await searchCity('Utrecht');
  fireEvent.click(screen.getByRole('button', { name: 'Create new room' }));
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Oudegracht 12' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Utrecht Centrum' } });
  fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '3511 AB' } });
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create new room' }));
  expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('Oudegracht 12');
  expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Utrecht Centrum');
  expect((screen.getByLabelText('Postcode') as HTMLInputElement).value).toBe('3511 AB');
});

it('says the list is cut off when the search was truncated', async () => {
  const room = (i: number) => ({ id: `r${i}`, venueName: `V${i}`, roomName: '', address: `A ${i}`, city: 'Amsterdam', postcode: '1000', floor: '', maxCapacity: 5 });
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ data: { rooms: [room(1)], truncated: true } }) }));
  vi.stubGlobal('fetch', fetchMock);
  render(<AddRoomFlow currency="EUR" />);
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Amsterdam' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByText('Showing the first 50. Add a street or venue to narrow it.')).toBeInTheDocument();
});
```

Run `pnpm exec vitest run src/components/settings/add-room-flow.test.tsx`. Expected: FAIL (no `City` field in the search step).

- [ ] **Step 4: `RoomSearchStep`**

- Fields: `<Input label="City" maxLength={CITY_MAX} placeholder="e.g. Amsterdam" />` and `<Input label="Street or venue (optional)" maxLength={ROOM_ADDRESS_MAX} placeholder="e.g. Keizersgracht" />`. Submit is disabled while `!city.trim()`; `handleSearch` returns early on the same condition.
- Call `searchRoomsByCity(city, q)`. Keep the `_reasonsHandled` pin, re-pointed at `RoomCitySearchOutcome`.
- `results` is `RoomCitySearchResult | null`. Render `results.rooms` through `RoomMatchList`. When `results.truncated`, show `<p className="type-caption mb-3">Showing the first {ROOM_CITY_SEARCH_LIMIT}. Add a street or venue to narrow it.</p>` above the list.
- Copy: found → `Shared rooms found:` and link `Or create a new room`; none → `No shared rooms found in this city.` and link `Create new room`.

- [ ] **Step 5: `AddRoomFlow`**

- Replace the `postcode`/`street` state with `city`/`q`. `results` becomes `RoomCitySearchResult | null`.
- Add `address: ''` and `postcode: ''` to `NewRoomForm` and `EMPTY_ROOM_FORM`.
- `onCreateNew`: `setRoomForm((f) => (f.city.trim() ? f : { ...f, city: city.trim() })); setStep('create');`. This only fills an empty city, so going Back and forward keeps whatever the teacher typed in the create form.
- Rewrite the component docblock's sentence about `postcode`/`street` seeding the create form's address fields so it says what is now true: search's `city` seeds the create form's city when that is empty. Keep the rest of the docblock.

- [ ] **Step 6: `RoomCreateStep`**

- Drop the four removed props. Read `address` and `postcode` from `form` and write them via `set('address', …)` / `set('postcode', …)`.
- Address input: `placeholder="e.g. Keizersgracht 123"`. Directly below it, when `address.trim() !== '' && !/\d/.test(address)`, render `<p className="type-caption">Did you include the house number?</p>`. This is a hint, not an error: no `role="alert"`, not danger-coloured, and it doesn't block submit.
- Required check becomes: `if (!venueName.trim() || !address.trim() || !city.trim() || !postcode.trim()) { setCreateError('Venue name, address, city and postcode are required'); return; }`.
- `newRoom.address` = `address.trim()`, `newRoom.postcode` = `postcode.trim()`.

Run `pnpm exec vitest run src/components/settings/add-room-flow.test.tsx src/components/settings/share-room-button.test.tsx src/lib/room-search.test.ts`. Expected: PASS. `share-room-button.test.tsx` passes **without edits**.

- [ ] **Step 7: Prove the guards bite**

1. Make `onCreateNew` overwrite the city unconditionally → the Back-and-forward test must fail.
2. Seed `address: q` in `onCreateNew` (the original bug, in its new shape) → the "address empty" test must fail.
3. Turn the hint condition into `false` → the hint test must fail.
4. Drop `q` from the URL params → the endpoint-URL test must fail.
Record each failure's text, restore, and re-run green.

- [ ] **Step 8: e2e**

In `tests/e2e/teacher-journey.spec.ts`, `creates a room through settings`:
```ts
    // Step 1: search by city — a made-up one, so nothing is shared there.
    await page.getByLabel('City').fill(`Journeyville-${suffix}`);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText('No shared rooms found in this city.')).toBeVisible();
    await page.getByRole('button', { name: 'Create new room' }).click();

    // Step 2: the room itself. City arrives from the search.
    await page.getByLabel('Venue name').fill('Journey Venue');
    await page.getByLabel('Address').fill(`Journeyweg-${suffix} 1`);
    await page.getByLabel('Postcode').fill('9999JT');
    await page.getByLabel('Room name').fill('Main Studio');
    await page.getByLabel('Max capacity').fill('12');
```
(Remove the old `City` fill. The rest of the test is unchanged.) Run `pnpm exec playwright test tests/e2e/teacher-journey.spec.ts -g "creates a room"`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/room-search.ts src/lib/room-search.test.ts src/components/settings/room-search-step.tsx src/components/settings/add-room-flow.tsx src/components/settings/room-create-step.tsx src/components/settings/add-room-flow.test.tsx tests/e2e/teacher-journey.spec.ts
git commit -m "feat: add-room search asks for a city; the create form starts with an empty address (#805)"
```

---

## Finish

- `pnpm run verify` green in the worktree, plus `pnpm run build` (to catch `room-search.ts` gaining a server-only import edge).
- Whole-branch review (two tasks), then PR → `/pr-review-toolkit:review-pr`.
- `pnpm run worktree:down` when done.
