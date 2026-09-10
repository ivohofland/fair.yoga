# fair.yoga production image — multi-stage, standalone Next.js output.
# Build:  docker build -t fairyoga .
# The `migrate` stage doubles as the one-off migration runner in
# docker-compose.prod.yml (it keeps the full node_modules with the
# Prisma CLI; the runtime image does not).

# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
# corepack reads `packageManager` from package.json and VERIFIES the pinned
# integrity hash before running pnpm — the reason this repo bootstraps here
# rather than with `npm i -g pnpm`. Corepack ships with Node "from 14.19.0
# up to (but not including) 25.0.0"; node:22-alpine and node:24-alpine both
# have it. Bumping this base image past 24 fails loudly here with
# `corepack: not found`, and the fix is `RUN npm i -g corepack` above.
RUN corepack enable
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
# Ensures the runner's COPY below always finds a directory — see
# docs/supply-chain.md for why this repo has no public/ of its own to
# depend on.
RUN mkdir -p public
# Build-time page-data collection instantiates PrismaClient, which only
# needs the env var to EXIST (no connection is made). Runtime env from
# compose overrides this dummy completely.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN pnpm exec prisma generate && pnpm run build

# ---------------------------------------------------------------------------
# Migration runner: `docker compose run migrate` / compose service.
FROM deps AS migrate
WORKDIR /app
COPY prisma ./prisma
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S app && adduser -S app -G app
USER app

COPY --from=build --chown=app:app /app/.next-build/standalone ./
COPY --from=build --chown=app:app /app/.next-build/static ./.next-build/static
COPY --from=build --chown=app:app /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
