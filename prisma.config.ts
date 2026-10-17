// `dotenv/config` loads `.env`: the CLI skips its own `.env` loading when a
// config file exists. The datasource is set only when a URL exists: `generate` needs
// none and must run without one, and `env()` would throw there.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const url = process.env.DATABASE_URL;
const paths = {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'pnpm exec tsx prisma/seed.ts' },
};

export default defineConfig(url === undefined ? paths : { ...paths, engine: 'classic', datasource: { url } });
