// `dotenv/config` is what loads `.env`: with a config file present the CLI no
// longer does. The datasource is set only when a URL exists, because `generate`
// runs as `postinstall` before `.env` does, and `env()` would throw there.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const url = process.env.DATABASE_URL;
const paths = {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'pnpm exec tsx prisma/seed.ts' },
};

export default defineConfig(url === undefined ? paths : { ...paths, engine: 'classic', datasource: { url } });
