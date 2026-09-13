// scripts/check-migrations.ts
import { findMigrationViolations } from '../src/lib/migration-policy';

try {
  const violations = findMigrationViolations();

  if (violations.length > 0) {
    console.error(`\n❌ Applied migrations have been amended (${violations.length} violation(s)):`);
    for (const v of violations) {
      if (v.type === 'renamed') {
        console.error(`  [${v.status}] ${v.oldPath} → ${v.path}`);
      } else {
        console.error(`  [${v.status}] ${v.path}`);
      }
    }
    console.error(
      `\nApplied migrations are checksummed and immutable. Amending one leaves existing\n` +
        `databases out of sync with the migration history and triggers destructive reset\n` +
        `prompts (or blocked deploys).\n\nTo change the schema, add a new migration via \`pnpm exec prisma migrate dev\`.\n`,
    );
    process.exit(1);
  }

  console.log('✓ No applied migrations amended');
} catch (err) {
  console.error(
    `Failed to verify migration immutability: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
