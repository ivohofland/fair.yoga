# fair.yoga production image — multi-stage, standalone Next.js output.
# Build:  docker build -t fairyoga .
# The `migrate` stage doubles as the one-off migration runner in
# docker-compose.prod.yml (it keeps the full node_modules with the
# Prisma CLI; the runtime image does not).

# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
# Build-time page-data collection instantiates PrismaClient, which only
# needs the env var to EXIST (no connection is made). Runtime env from
# compose overrides this dummy completely.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate && npm run build

# ---------------------------------------------------------------------------
# Migration runner: `docker compose run migrate` / compose service.
FROM deps AS migrate
WORKDIR /app
COPY prisma ./prisma
CMD ["npx", "prisma", "migrate", "deploy"]

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
