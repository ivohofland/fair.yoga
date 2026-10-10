# Deploying fair.yoga

Single-VPS deployment: Docker (app + Postgres) behind host-level Nginx with
Let's Encrypt. Sized for a 2GB VPS.

## 1. Prerequisites

- A VPS with Docker + the compose plugin, Nginx, and certbot installed
- A domain pointing at the VPS — an `A` record, and an `AAAA` record if the
  VPS has IPv6 (Let's Encrypt then validates over IPv6, which is why the nginx
  example listens on both)
- A [Lettermint](https://lettermint.co) project API token (`lm_…`) for transactional email, with two transactional routes (see Email provider below)

## 2. First deploy

```bash
git clone https://github.com/ivohofland/fair.yoga.git /opt/fairyoga
cd /opt/fairyoga
cp .env.example .env
chmod 600 .env
```

Edit `.env` — every value matters in production. `.env.example` is written
for local development, so a few lines change shape here: delete
`DATABASE_URL` and `DATABASE_URL_TEST` (the compose file builds the app's
`DATABASE_URL` from `POSTGRES_PASSWORD`, and its value wins over the
`.env` one), and add `POSTGRES_PASSWORD`, which the example only carries
commented out. Keep a copy of the finished file outside the VPS: the secrets
in it cannot be regenerated without consequences (the VAPID row below).

| Variable | Notes |
|---|---|
| `POSTGRES_PASSWORD` | generate one: `openssl rand -hex 24` (hex, because it is interpolated into a connection URL). Set it before the first `up`: Postgres reads it only when it initialises the `pgdata` volume, so changing it later leaves the database on the old one |
| `CRON_SECRET` | `openssl rand -hex 24` — without it the `/api/cron/*` endpoints stay disabled (the in-process scheduler runs regardless); it also unlocks `/api/health`'s per-job detail, and is checked there on a public path, so keep it high-entropy |
| `LETTERMINT_API_TOKEN` / `EMAIL_FROM` | real token + a sender on the verified domain. Without the token production refuses every send; the failure reaches the logs, and `/api/health` through the email-fallback sweep and the digest job, rather than "sending" silently |
| `LETTERMINT_CLASS_ROUTE` | slug of a second **transactional** route for class mail (audience table: `docs/superpowers/specs/2026-10-10-email-provider-seam-design.md`). Unset, class mail shares the default route, so a spam complaint about an announcement or invitation suppresses that address's sign-in mail. Not a broadcast route: its hosted unsubscribe is an opt-out list the app cannot see |
| `EMAIL_REPLY_TO` | default `hello@fair.yoga`; set on platform mail only, never on class mail (audience table: `docs/superpowers/specs/2026-10-10-email-provider-seam-design.md`) |
| `EMAIL_DRY_RUN` | leave unset. `1` logs mail instead of sending it, with magic-link and invitation URLs printed in full — a bring-up mode for a server no one else signs in to yet (read the link with `docker compose -f docker-compose.prod.yml logs app \| grep "Magic link"`), never one to leave on, since the log then holds working sign-in tokens |
| `OPERATOR_EMAIL` | required in production; the daily degradation digest goes here (§7). Unset, a degradation event fails the `daily-cleanup` job instead of reaching you |
| `NEXT_PUBLIC_APP_URL` | `https://yourdomain.example`, no trailing slash — the origin in every emailed link, and the origin passkey ceremonies are checked against, so it must be the exact host people use (redirect `www.` to it rather than serving both). Read at runtime: `.dockerignore` keeps `.env` out of the build, so `next build` never sees it and inlines nothing; the same is why a client component reading it would get `undefined` |
| `PASSKEY_RP_ID` | your bare domain. Never change it once passkeys exist: each is bound to it |
| `ADMIN_HOST` | `.env.example` ships a local value; delete the line to keep the admin surface off, or set `admin.<domain>` per §8 Admin access |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | generate the keys with `pnpm run vapid:keys`; `VAPID_SUBJECT` must be a `mailto:` or `https://` URL; unset disables push, and rotating the pair silently orphans every existing subscription (browsers re-subscribe only when the user turns push on again) |

### Email provider

- Open and click tracking must be **off** in the Lettermint project. Click tracking rewrites links through the provider's redirect domain and would hand it magic-link tokens. The project settings page does not hold this switch ("Use your own tracking domain" there only renames the redirect domain); look on each route. Confirm it on a received magic link: its URL must start with `NEXT_PUBLIC_APP_URL`, not a Lettermint domain.
- Turn **Hide email content** on in the project settings. Otherwise every magic link is readable in the Lettermint dashboard, so access to that account is access to every account here.
- Set **Bounce and complaint forwarding** to the operator address, so bounces and spam complaints reach a person.
- Send from a subdomain (`notify.fair.yoga`) and publish the SPF and DKIM records Lettermint gives you for it.
- Publish one DMARC record on the apex, starting at `p=none` with `rua=mailto:ops@fair.yoga`.

Then:

```bash
docker compose -f docker-compose.prod.yml up -d --build
curl -s http://127.0.0.1:3000/api/health   # → {"status":"ok","db":"up"}
curl -s -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/health   # → {"status":"ok","db":"up","jobs":{...},"degradations":{"open":0}}
```

The `migrate` service applies Prisma migrations before the app starts.
The app binds to `127.0.0.1:3000` only — Nginx is the public face.

## 3. Nginx + TLS

The certificate comes first, because nginx refuses to load the example's
`listen ... ssl` blocks while the certificate files they name do not exist.
Serve only the port-80 block until certbot has run (add `admin.<domain>` to
`server_name` and to `-d` if you use §8 Admin access):

```bash
tee /etc/nginx/sites-available/fairyoga >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name yourdomain.example;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}
EOF
ln -s /etc/nginx/sites-available/fairyoga /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/html -d yourdomain.example -m you@yourdomain.example --agree-tos --no-eff-email
```

Then install the full config and reload:

```bash
cp deploy/nginx.conf.example /etc/nginx/sites-available/fairyoga
# edit every yourdomain.example; drop the admin blocks unless you use §8
nginx -t && systemctl reload nginx
```

`certonly --webroot` leaves the nginx config alone, so certbot also does not
reload nginx after a renewal — without a hook, nginx keeps serving the old
certificate from memory until it expires. Install one, and check it fires:

```bash
tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
certbot renew --dry-run --run-deploy-hooks
grep "Running deploy-hook" /var/log/letsencrypt/letsencrypt.log | tail -1
```

Until the app is up, `https://yourdomain.example` answers 502 — nginx and TLS
are working and nothing listens on port 3000 yet.

The proxy config sets `X-Forwarded-For` (the rate limiter keys on it) and
disables buffering for the SSE endpoint. Serve the app on the default HTTPS
port (or have nginx forward the port in `Host`): writes are refused when the
browser's Origin and the forwarded Host differ.

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

That log path assumes root's crontab. From a non-root user in the `docker`
group, log to a file that user can write (its home directory, say), and make
sure it owns `/var/backups/fairyoga`.

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
answers `ok` — the job list in its cron-secret body is simply empty — so the boot warning is the only
sign. The app logs a warning at boot when the scheduler is off.

The `/api/cron/*` endpoints are for running a job by hand between its ticks —
useful for the hourly and daily jobs — alongside the scheduler, not instead of
it. Every job already runs within 15 seconds of the app starting, so a
restart needs none. Not every job has been examined for a manual call that
overlaps its own tick — `docs/technical-architecture.md` (Cron Jobs →
Overlapping triggers) says which were.

nginx refuses `/api/cron/` from outside, so the call is made on the VPS itself.

```bash
curl --fail -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/daily-cleanup
# also: /api/cron/transition-classes  /api/cron/generate-classes  /api/cron/email-fallback  /api/cron/payment-reminders  /api/cron/class-reminders
```

`--fail` is not optional here, and `/api/cron/daily-cleanup` is why. That route
runs several sweeps and its **status is the verdict**: 200 only when every sweep
ran, 503 when every failure was a lost lock race (retry, and back off), 500
otherwise (a permanent fault — retrying will not clear it). The body carries
every outcome either way, so `data.auth.ok`, `data.waitlistRetention.ok`,
`data.notificationRetention.ok`, `data.pushSubscriptionRetention.ok`,
`data.timezoneAudit.ok`, and `data.degradationDigest.ok` say which one failed. Without `--fail`, `curl`
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

- `GET /api/health` — liveness and DB reachability (503 when the DB is down)
  as `{ status, db }`, where `status` is `degraded` once any job is unhealthy
  or the DB is down.
  A monitor needs only that public summary; the per-job scheduler state below
  needs the cron secret (`Authorization: Bearer $CRON_SECRET`).
  `jobs.<name>.healthy` flips false when a job errors, and also when its run
  is still in flight when a second consecutive tick comes due —
  `STALLED_AFTER_SKIPPED_TICKS` in
  `src/lib/scheduler.ts` — which is at most two of the job's own intervals
  after the run began, so a couple of minutes for a job that ticks every
  minute and two days for the daily one; each job's interval is
  `intervalMs` in `buildJobs`. From that tick on, the scheduler logs an
  `error` line — `scheduler job run still in flight; reporting it unhealthy`,
  with `job`, `skippedTicks` and `runningSince` fields — on that tick and
  every refused tick after it, so an operator can grep for that message; the
  job stays unhealthy until the run settles, and from then the verdict rests
  on that run's own outcome. An idle-in-transaction session holding a
  lock is one cause — the `pg_blocking_pids()` / `pg_stat_activity` advice in
  the `class-generation` bullet below applies to any job, not only that one.
  `degradations.open` is the number of degradation events that fired in the
  last 24 hours: a bare count, with no codes, in the secret-holder's body only.
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
  makes it due again. With `EMAIL_DRY_RUN=1` the digest is not sent (only its
  subject is logged), and the scheduler warns about it at boot. Point your uptime monitor
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

## 8. Admin access

The platform-admin surface (#60) answers on its own host, served by the same
app process. It is off unless `ADMIN_HOST` is set. Design and gate:
`docs/technical-architecture.md` (Admin surface).

1. Add a DNS `A`/`AAAA` record for `admin.<domain>`.
2. Copy the admin `server` blocks from `deploy/nginx.conf.example` and edit the
   name.
3. Extend the certificate (the admin name must already be in the port-80
   block's `server_name`, §3): `certbot certonly --webroot -w /var/www/html
   --expand -d <domain> -d admin.<domain>`
   (one certificate, two names).
4. Set `ADMIN_HOST=admin.<domain>` and `PASSKEY_RP_ID=<domain>` (the parent
   domain, so a passkey registered on the main site also signs in on the admin
   host), then redeploy.
5. Register a passkey on the main site as the person who is to be an admin
   (they need a teacher or student profile), then grant, revoke and list from
   the `migrate` image, which carries the CLI:

   ```bash
   docker compose -f docker-compose.prod.yml run --rm migrate pnpm admin:grant <email> --by <name>
   docker compose -f docker-compose.prod.yml run --rm migrate pnpm admin:revoke <email> --by <name>
   docker compose -f docker-compose.prod.yml run --rm migrate pnpm admin:list
   ```

6. Optional: if your admins have fixed addresses, put `allow <ip>; deny all;`
   in the admin vhost.

**Smoke test after the first deploy.** The passkey sign-in cannot be exercised
locally (browsers refuse it on `admin.localhost`), so production is where it is
first seen working: register a passkey on the main site, grant that account,
sign in with the passkey on `https://admin.<domain>/admin/sign-in`, and confirm
the dashboard shows the platform counts. A signed-in non-admin at the same
address gets the ordinary 404 page.
