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
| `NEXT_PUBLIC_APP_URL` | `https://yourdomain.example` — used in magic-link emails |
| `PASSKEY_RP_ID` | your bare domain |

Then:

```bash
docker compose -f docker-compose.prod.yml up -d --build
curl -s http://127.0.0.1:3000/api/health   # → {"status":"ok","db":"up","jobs":{...}}
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

## 4. Backups

```bash
chmod +x deploy/backup.sh
crontab -e   # add:
# 17 3 * * * /opt/fairyoga/deploy/backup.sh >> /var/log/fairyoga-backup.log 2>&1
```

Nightly `pg_dump | gzip` into `/var/backups/fairyoga`, 14-day rotation.
Restore: `gunzip -c backup.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U fairyoga fairyoga`.

## 5. Scheduled jobs

Lifecycle automation (class transitions, generation, email fallback,
payment reminders) runs **inside the app process** — nothing to configure.
To drive it externally instead (e.g. from systemd timers), set
`CRON_SCHEDULER=off` in `.env` and hit the endpoints with the secret:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://yourdomain.example/api/cron/transition-classes
# also: /api/cron/generate-classes  /api/cron/email-fallback  /api/cron/payment-reminders  /api/cron/auth-cleanup
```

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
  job errors); point your uptime monitor here.
- `docker compose -f docker-compose.prod.yml logs -f app` — scheduler and
  request logs.
