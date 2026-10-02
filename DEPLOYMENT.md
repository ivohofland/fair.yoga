# Deploying fair.yoga

Single-VPS deployment: Docker (app + Postgres) behind host-level Nginx with
Let's Encrypt. Sized for a 2GB VPS.

## 1. Prerequisites

- A VPS with Docker + the compose plugin, Nginx, and certbot installed
- A domain pointing at the VPS
- A [Resend](https://resend.com) API key for transactional email

## 2. First deploy

```bash
git clone https://github.com/ivohofland/fair.yoga.git /opt/fairyoga
cd /opt/fairyoga
cp .env.example .env
```

Edit `.env` — every value matters in production:

| Variable | Notes |
|---|---|
| `POSTGRES_PASSWORD` | generate one: `openssl rand -hex 24` |
| `CRON_SECRET` | `openssl rand -hex 24` — without it the `/api/cron/*` endpoints stay disabled (the in-process scheduler runs regardless) |
| `RESEND_API_KEY` / `EMAIL_FROM` | real key + verified sender; the app refuses to "send" silently without them |
| `OPERATOR_EMAIL` | required in production; the daily degradation digest goes here (§7). Unset, a degradation event fails the `daily-cleanup` job instead of reaching you |
| `NEXT_PUBLIC_APP_URL` | `https://yourdomain.example` — used in magic-link emails |
| `PASSKEY_RP_ID` | your bare domain |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | generate with `pnpm run vapid:keys`; unset disables push, and rotating the pair silently orphans every existing subscription (browsers re-subscribe only when the user turns push on again) |

Then:

```bash
docker compose -f docker-compose.prod.yml up -d --build
curl -s http://127.0.0.1:3000/api/health   # → {"status":"ok","db":"up","jobs":{...},"degradations":{"open":0}}
```

The `migrate` service applies Prisma migrations before the app starts.
The app binds to `127.0.0.1:3000` only — Nginx is the public face.

## 3. Nginx + TLS

```bash
cp deploy/nginx.conf.example /etc/nginx/sites-available/fairyoga
# edit server_name, then:
ln -s /etc/nginx/sites-available/fairyoga /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d yourdomain.example
```

The proxy config sets `X-Forwarded-For` (the rate limiter keys on it) and
disables buffering for the SSE endpoint.

The teacher photo upload route gets its own `location` block with a raised
`client_max_body_size` (10m) — the app already refuses anything above
`MAX_PHOTO_BYTES` (`src/lib/teacher-photo-limits.ts`; 8 MB today), in JSON, so
this only has to be large enough to let a request through to the app for it to
answer. Everything else keeps nginx's 1 MB default.

`GET /api/teacher-photos/*` answers `Cache-Control: public, max-age=31536000,
immutable`, so a shared cache or CDN placed in front of this app must not
cache it — otherwise a replaced or erased teacher's photo would stay
reachable at the edge past the origin's own 404.

## 4. Backups

```bash
chmod +x deploy/backup.sh
crontab -e   # add:
# 17 3 * * * /opt/fairyoga/deploy/backup.sh >> /var/log/fairyoga-backup.log 2>&1
```

Nightly `pg_dump | gzip` into `/var/backups/fairyoga`, 14-day rotation.
Restore: `gunzip -c backup.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U fairyoga fairyoga`.

## 5. Scheduled jobs

The scheduled jobs (roster in `src/lib/scheduler.ts`, also
`docs/technical-architecture.md` § Cron Jobs) run **inside the app process**,
and in production they must — nothing to configure.

`CRON_SCHEDULER=off` is a CI setting: tests drive the same services with their
own clocks, so CI does not need the in-process scheduler running. It is not a
production mode. With it set, no scheduled job runs in the app: classes don't
start, auto-cancel, or complete; recurring classes aren't generated; fallback
emails, payment reminders and class reminders don't send; daily cleanup
(retention, expired sessions and auth tokens, the timezone audit, the
degradation digest) doesn't run. Waitlist reconciliation is worse off than the
rest — it has no endpoint, so it cannot be run any other way — and a seat freed by a cancellation whose spot-freed
hook was dropped (§7) is never offered to the queue. `/api/health` still
answers `ok` — its job list is simply empty — so the boot warning is the only
sign. The app logs a warning at boot when the scheduler is off.

The `/api/cron/*` endpoints are for running a job by hand between its ticks —
useful for the hourly and daily jobs — alongside the scheduler, not instead of
it. Every job already runs within 15 seconds of the app starting, so a
restart needs none. Not every job has been examined for a manual call that
overlaps its own tick — `docs/technical-architecture.md` (Cron Jobs →
Overlapping triggers) says which were:

```bash
curl --fail -X POST -H "Authorization: Bearer $CRON_SECRET" https://yourdomain.example/api/cron/daily-cleanup
# also: /api/cron/transition-classes  /api/cron/generate-classes  /api/cron/email-fallback  /api/cron/payment-reminders  /api/cron/class-reminders
```

`--fail` is not optional here, and `/api/cron/daily-cleanup` is why. That route
runs several sweeps and its **status is the verdict**: 200 only when every sweep
ran, 503 when every failure was a lost lock race (retry, and back off), 500
otherwise (a permanent fault — retrying will not clear it). The body carries
every outcome either way, so `data.auth.ok`, `data.waitlistRetention.ok`,
`data.notificationRetention.ok`, `data.timezoneAudit.ok`, and
`data.degradationDigest.ok` say which one failed. Without `--fail`, `curl`
exits 0 on all of those, so a script or a manual call that skips the flag
reports success for a run in which a sweep did not run.

## 6. Updates

```bash
cd /opt/fairyoga
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run automatically via the `migrate` service on every deploy.

## 7. Monitoring

- `GET /api/health` — liveness, DB reachability (503 when the DB is down),
  and per-job scheduler state (`jobs.<name>.healthy` flips false when a
  job errors, and also when its run is still in flight when a second
  consecutive tick comes due — `STALLED_AFTER_SKIPPED_TICKS` in
  `src/lib/scheduler.ts` — which is at most two of the job's own intervals
  after the run began, so a couple of minutes for a job that ticks every
  minute and two days for the daily one; each job's interval is
  `intervalMs` in `buildJobs`). From that tick on, the scheduler logs an
  `error` line — `scheduler job run still in flight; reporting it unhealthy`,
  with `job`, `skippedTicks` and `runningSince` fields — on that tick and
  every refused tick after it, so an operator can grep for that message; the
  job stays unhealthy until the run settles, and from then the verdict rests
  on that run's own outcome. An idle-in-transaction session holding a
  lock is one cause — the `pg_blocking_pids()` / `pg_stat_activity` advice in
  the `class-generation` bullet below applies to any job, not only that one.
  `degradations.open` is the number of degradation events that fired in the
  last 24 hours: a bare count, with no codes, so the endpoint stays public.
  Which ones fired is in the digest email and, per code, in
  `docs/degradation-sites.md`. If the digest cannot be sent, `daily-cleanup`
  reads unhealthy. With `OPERATOR_EMAIL` unset, the server log line names the
  due codes. When the provider refuses, the thrown error carries its reason
  (`degradation digest not delivered: …`), and the events stay due, so the next
  daily run retries. `SELECT code FROM "DegradationEvent" WHERE "lastNotifiedAt" IS NULL OR "lastNotifiedAt" < "lastSeenAt"`
  lists the codes the next digest will carry. A claim that could not be put
  back after a failed claim, render or send leaves its event marked told without an email; the
  `error` line `could not release a degradation digest claim` names its
  `code`, and `UPDATE "DegradationEvent" SET "lastNotifiedAt" = NULL WHERE code = '<code>'`
  makes it due again. With `EMAIL_DRY_RUN=1` the digest is logged and not
  sent, and the scheduler warns about it at boot. Point your uptime monitor
  here.
- `waitlist-reconciliation` tolerates contention for
  `MAX_CONSECUTIVE_CONTENDED_TICKS` ticks before its own failures flip it; a
  pass still in flight flips it at its second refused tick, like any job,
  under the rule in the bullet above. It runs every minute and repairs
  waitlists whose live spot-freed hook was dropped, so a single lost row-lock
  race is routine and self-healing. It reports the job unhealthy when a
  failure will not clear by retrying, or
  when five consecutive ticks lost **every** class to contention
  (`MAX_CONSECUTIVE_CONTENDED_TICKS` in
  `src/services/waitlist-reconciliation.ts`) — roughly five minutes of an
  unbroken hold. "Every class" means every class the tick actually **invoked**:
  candidates it skipped (already full, a broadcast already standing, past the
  cancel deadline) count neither way. So a class stuck behind siblings that are
  genuinely being reconciled in the same tick does **not** flip the flag on its
  own — while a tick in which the stuck class was the only one invoked, because
  everything else was skipped for an unrelated reason, contributes to the
  tick-level streak like any other all-invoked-and-failed tick. Either way the
  stuck class logs at `error` with a `classStreak` field naming it, and nothing
  delivers that line anywhere today: logs go to stdout with no transport
  configured, so watching for it means reading the server logs directly (the
  `docker compose … logs` command below). Log lines are not alerted on.
  What is alerted: a fallback that substitutes a value (a degradation event,
  `docs/degradation-sites.md`) is emailed to `OPERATOR_EMAIL` once a day, when
  it is new or has fired again since you were last told.
- `class-generation` runs hourly and skips a recurring or studio template
  whose row is locked, since a teacher saving an edit at that moment is
  routine. A genuine failure reddens the job on the sweep it happens in; a
  contended skip does so only when the same template has been skipped on
  `MAX_CONSECUTIVE_CONTENDED_SWEEPS` consecutive runs
  (`src/services/generation-contention.ts`) — three consecutive hourly runs,
  roughly two to three hours of an unbroken hold — and stays unhealthy until the first run after the lock is released. The
  blocking lock may be on the template's own row or on a row its generation
  writes against: the teacher, the room, the schedule rule, or an overlapping
  uncommitted calendar entry. Each such run logs an `error` line naming the
  `templateId`, `teacherId` and `streak`. An idle-in-transaction session is
  one cause; find the holder with `pg_blocking_pids()` and
  `pg_stat_activity`. The manual `POST /api/cron/generate-classes` never
  escalates this on its own. The streak lives in memory, so a process restart
  resets it to zero.
- `docker compose -f docker-compose.prod.yml logs -f app` — scheduler and
  request logs.
