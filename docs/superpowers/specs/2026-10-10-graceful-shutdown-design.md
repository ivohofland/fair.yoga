# Graceful shutdown: streams end on SIGTERM (#816)

## What was measured

The issue's premise holds, checked against the installed code rather than taken
from the issue:

- `next@16.3.4`, `node_modules/next/dist/server/lib/start-server.js`: the
  `cleanup` handler is registered on `SIGINT` and `SIGTERM` unless
  `NEXT_MANUAL_SIG_HANDLE` is set. It awaits `server.close()`, then
  `nextServer.close()`, then `process.exit(143)` for SIGTERM. It calls
  `server.closeAllConnections()` only when `isDev`. The listener is registered
  **before** `getRequestHandlers`, which is what loads `instrumentation.ts`, so
  Next's listener always runs first and ours runs second.
- Production runs `node server.js` from the standalone output (`Dockerfile`,
  `CMD ["node", "server.js"]`), which calls that same `startServer`.
- `src/app/api/notifications/stream/route.ts` ends a stream on `abort` or a
  failed keepalive revalidation, and on nothing else.
- On Node 24.21.0, an experiment with a plain `http` server holding one SSE
  response open: `server.close()` called, then the response ended, the close
  callback fired **1 ms** later. So ending the streams is enough to let Next's
  own sequence finish; nothing else has to close the sockets.
- The client (`src/components/layout/live-updates.tsx`) rebuilds a `CLOSED`
  `EventSource` with backoff, so a 503 refusal is handled by code that already
  exists; a cleanly ended stream is retried by the browser itself.

The one thing the issue undersold: the shutdown state has to live on
`globalThis`, not in a module. `instrumentation.ts` and the route handlers are
separate bundle entries, the reason `__fairYogaSseCounts` and
`__fairYogaJobHealth` are already global.

## Design

### `src/lib/shutdown.ts`

Process-wide state on `globalThis.__fairYogaShutdown`:

- `isShuttingDown(): boolean`
- `onShutdown(fn): () => void` — subscribes; returns the unsubscribe. A
  subscription made after shutdown began runs `fn` immediately, so no caller
  can subscribe into a state that will never fire.
- `beginShutdown(): void` — idempotent. Sets the flag, then calls each
  subscriber once. A subscriber that throws is logged and does not stop the
  others.
- `installShutdownSignal(target = process): void` — `target.once('SIGTERM')`
  and `target.once('SIGINT')` both call `beginShutdown`. Guarded on
  `globalThis` so a second call installs nothing. The pair mirrors Next's own,
  and `NEXT_MANUAL_SIG_HANDLE` stays unset: Next keeps owning `server.close()`
  and `process.exit`.

`instrumentation.ts` calls `installShutdownSignal()` in the nodejs branch
before `startScheduler()`.

### The stream route

- After `validateSession` (the last `await`; everything after it runs
  synchronously through `ReadableStream`'s `start`), a request arriving while
  `isShuttingDown()` answers **503** and subscribes nothing — placed before the
  429 check, since the process is going away whatever the count. Checking only
  after the await is what makes the check race-free; a check before it would
  save one query and still need this one.
- Inside `start`, the stream subscribes with `onShutdown(cleanup)` as its last
  step (after the keepalive and bus handler exist), and `cleanup` calls the
  returned unsubscribe. `cleanup`'s existing `closed` guard keeps every path —
  abort, failed revalidation, failed enqueue, shutdown — to one run.

### The scheduler — decision

**Options.** (A) Stop starting new ticks once shutdown begins; a tick already
running is abandoned when Next calls `process.exit`. (B) Await an in-flight
tick, bounded, before the process exits.

**Taken: A.** B has no honest place to wait. Next's sequence awaits nothing the
app registers in production (`cleanupListeners` exists only when `isDev`), and
our listener runs after Next's has already started `server.close()`. Awaiting
would mean setting `NEXT_MANUAL_SIG_HANDLE` and owning the whole sequence,
with no handle on the `server` the generated standalone `server.js` creates.
The one hold available — keeping the streams open until ticks finish — would
wait only when a stream happens to be open, which is a rule nobody could rely
on.

What A costs: a tick in flight at exit has its open transaction rolled back by
Postgres, and the next container's scheduler re-runs the sweep. That is what a
SIGKILL did before, so A is no new failure mode. It is a shorter window, though:
with a stream open, a running tick used to get up to the 3 s grace before the
kill, and now gets until `server.close()` completes. Without a stream open it
already got nothing, since `server.close()` returned at once.

`makeTick` returns before running when `isShuttingDown()`, without touching
`skippedTicks` (a refused tick during shutdown is not a stall).

### Docs

- `docs/technical-architecture.md` gains a `### Shutdown` section under
  Deployment describing the sequence; Cron Jobs gains one sentence linking it.
- `docker-compose.prod.yml`'s comment on `stop_grace_period` says it is a
  backstop. The value stays 3 s; `deploy/compose.test.ts` keeps its bound.

## Acceptance, mapped

| Criterion | Where |
|---|---|
| Open streams closed on shutdown, bus handler removed | route unit test |
| Stream after shutdown refused without subscribing | route unit test |
| abort / invalid session still clean up once | route unit test (existing paths, plus shutdown-after-abort) |
| Production build exits by itself, 143, well under grace | measured, recorded in PR body |
| Scheduler decision implemented and tested | `scheduler.test.ts` |
| Docs and compose comment | this branch |
