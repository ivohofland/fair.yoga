# Push dispatch: surface misconfiguration and tick faults without waiting for a claimed row (#748)

Follow-up to #743 / #747 (`2026-10-03-push-health-design.md`).

## Premise, as measured

All three of the issue's findings hold. Re-derived from the code at `6a4d6510`:

1. **Misconfiguration needs traffic.** `dispatchPushes` increments `unsendable` only in
   `worker()`, after a successful claim (`if (!sender) { if (misconfigured) result.unsendable += 1; … }`).
   `observePushTick` counts a tick as failing on `failed > 0 || unsendable > 0`. With broken
   `VAPID_*` and no new `Notification` rows, every tick is idle: the streak never starts and
   `/api/health` stays `ok`. The only other signal is the once-per-process `log.error`
   (`reportedUnconfigured`).
2. **A throwing tick loses its counts.** The `push dispatch tick` summary is the last statement
   of `dispatchPushes`, after both `throw` sites (a worker crash; a `PushSendFault`). `retired`
   is committed by then, and the sends that did happen are real, yet nothing records them.
3. **`PushDispatchDegradedError` carries only `failedTicks`.** Its message is
   `push delivered nothing in N failing ticks`; `makeTick` logs it every 10 s as
   `scheduler job failed` with no cause. The state already knows more (it is told per tick
   whether the evidence was failed sends, a misconfiguration or a fault) and throws it away.

No open PR touches `push-dispatch.ts`, `push-health.ts` or `scheduler.ts`.

## Design

### (1) The diagnosis is part of every tick's result

`PushDispatchResult.unsendable: number` stays (rows claimed while unable to send: it is the
log's count). It gains `misconfigured: MisconfiguredVapid | null`, where
`MisconfiguredVapid = Exclude<VapidConfigProblem, 'unset'>`: set from `resolveSender`'s
diagnosis on **every** tick, claimed row or not. `null` for a working configuration, an unset
environment (a choice, not a fault) and an injected sender.

`observePushTick` takes `misconfigured !== null` as failing evidence **in place of**
`unsendable > 0` (`unsendable > 0` implies it, so nothing is lost). With broken `VAPID_*` the
streak therefore starts on the first tick after boot with or without traffic and the alarm
stands from the 3rd tick (about 30 s after boot: the push job's first tick is its interval).
It stays raised for as long as the configuration stays broken, since each tick re-extends the
streak, and clears 15 minutes after the environment is fixed (a restart, which also resets the
in-memory streak, is how `VAPID_*` is fixed).

A misconfigured tick that claims rows still logs its `info` summary (`unsendable > 0`); one
that claims nothing does not, so an idle misconfigured deployment logs once per tick only
through the scheduler's `scheduler job failed` line, which (3) makes informative.

### (2) A throwing tick logs what it did

`dispatchPushes` becomes a thin wrapper that owns the result object and the summary; the body
(unchanged) is `runPushDispatch(db, send, now, clock, result)`, which mutates the result it is
handed. The wrapper logs the summary on **both** paths: on success under the existing
condition; on a throw always, with `faulted: true`, then rethrows the original error. One call
site covers a claim failure before the first candidate (`retired` committed, nothing else), a
worker crash and a `PushSendFault`.

### (3) The error says why

`PushHealthState`'s failing variant gains `lastCause: PushFailureCause`:

```
{ kind: 'misconfigured'; reason: MisconfiguredVapid }
| { kind: 'send-failed' }
| { kind: 'fault'; name: string }
```

`observePushTick` takes a `PushTickObservation` (`completed` with the result's
`sent`/`failed`/`misconfigured`, or `threw` with the fault's name) and sets the cause on every
tick that extends the streak. `PushDispatchDegradedError(failedTicks, lastCause)` renders it:
`push delivered nothing in 3 failing ticks (last: VAPID_* misconfigured: partial)`. Quiet ticks
after a fault keep the cause of the last failing one, so the alarm that outlives a one-off
fault still names it.

Not carried: the push service's last HTTP status. A `failed` outcome already logs it per send
(`push send failed; not retried`), and aggregating it into the result would add a field whose
only reader is a message the log line beside it already answers.

## Not in scope

- `/api/health` is unchanged: it already reports the job unhealthy while the job throws.
- Restart-surviving health state, as in #743.
- The positional `dispatchPushes(db, send, now, clock)` signature (#747 left it; unchanged).
