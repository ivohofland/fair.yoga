import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'path';

// Two projects with different blast radii (docs/test-database.md):
// - unit: services + lib, runs against the dedicated test database so
//   clock-injected sweeps can never touch dev/seed data
// - integration: talks to the HTTP app on :3000, so its fixtures must
//   live in the same database that app reads (dev locally, CI's in CI)
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const devUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL ?? '';
  const testUrl = process.env.DATABASE_URL_TEST ?? fileEnv.DATABASE_URL_TEST ?? devUrl;

  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    test: {
      globals: true,
      environment: 'node',
      fileParallelism: false,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
      },
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts'],
            env: { DATABASE_URL: testUrl },
            globalSetup: ['./tests/setup/unit-db.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['tests/integration/**/*.test.ts'],
          },
        },
      ],
    },
  };
});
