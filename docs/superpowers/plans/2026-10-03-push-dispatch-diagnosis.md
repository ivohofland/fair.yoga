# Push dispatch diagnosis (#748) — plan

Spec: `docs/superpowers/specs/2026-10-03-push-dispatch-diagnosis-design.md`.
Each task is test-first: write the failing test, see it fail, implement, see it pass, then
break the guard once and record the failure text in the PR body.

## Task 1 — `misconfigured` rides every tick's result

- `src/services/push-dispatch.ts`: `PushDispatchResult` gains `misconfigured`; `resolveSender`
  returns the diagnosis' reason (not just a boolean); the result carries it whether or not any
  row is claimed. `unsendable` is unchanged.
- `src/services/push-dispatch.test.ts`: an idle tick (no rows) under each misconfiguration
  reports its reason; an unset environment and an injected sender report `null`.
- Fix every `PushDispatchResult` literal the compiler then names.

## Task 2 — a throwing tick logs its counts

- `src/services/push-dispatch.ts`: split `dispatchPushes` into a wrapper that owns the result
  and the summary log, and the existing body mutating a handed-in result. Throw path logs
  `faulted: true` and rethrows the same error object.
- `src/services/push-dispatch.test.ts`: a `PushSendFault` tick and a worker-crash tick each log
  the counts (`retired`, `sent`) with `faulted: true` and still reject with the original error;
  a clean tick's log is unchanged (no `faulted` key).

## Task 3 — the health state names the cause

- `src/services/push-health.ts`: `PushTickObservation`, `PushFailureCause`, `lastCause` on the
  failing state variant, `misconfigured !== null` as evidence, `PushDispatchDegradedError`
  rendering the cause.
- `src/services/push-health.test.ts`: idle ticks under a misconfiguration raise the alarm; each
  cause shows in the error; a quiet tick after a fault keeps the fault's cause; a later cause
  replaces an earlier one inside one streak.
- `docs/technical-architecture.md` (Cron Jobs, Push dispatch row): the misconfiguration is
  evidence on every tick; a throwing tick logs; the error names its cause.
- `src/lib/scheduler.test.ts` only if its fixtures name the changed shapes.

## Guards to mutate (Task 3 owns the sweep)

1. Drop `misconfigured` from the evidence → the idle-misconfigured test fails.
2. Log only on success → the throwing-tick tests fail.
3. Never update `lastCause` on a quiet tick vs. always overwrite → the fault-survives-quiet-tick
   test distinguishes them.
4. Message omits the cause → the message test fails.
