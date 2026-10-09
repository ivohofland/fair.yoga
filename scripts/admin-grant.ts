/**
 * Operator CLI for admin grants (#60); where grants come from: docs/data-model.md (AdminGrant).
 *   pnpm admin:grant  <email> --by <name>
 *   pnpm admin:revoke <email> --by <name>
 *   pnpm admin:list
 * In production it runs from the `migrate` image (DEPLOYMENT.md, Admin access).
 */
import { PrismaClient } from '@prisma/client';
import { grantAdmin, revokeAdmin, listAdmins } from '../src/services/admin-grants';

const USAGE = 'usage: admin-grant.ts grant|revoke <email> --by "<name>" (quote a name with spaces)  |  admin-grant.ts list';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, email, flag, by, ...extra] = process.argv.slice(2);
  const db = new PrismaClient();
  try {
    if (command === 'list') {
      for (const a of await listAdmins(db)) {
        console.log(`${a.email}\tgranted ${a.grantedAt.toISOString()} by ${a.grantedBy}${a.dormant ? '\tDORMANT (no live profile)' : ''}`);
      }
      return;
    }
    if ((command !== 'grant' && command !== 'revoke') || !email || flag !== '--by' || !by || extra.length > 0) fail(USAGE);

    const outcome = command === 'grant' ? await grantAdmin(db, { email, by }) : await revokeAdmin(db, { email, by });
    if (outcome.kind === 'refused') fail(`refused: ${outcome.reason}`);
    console.log(outcome.kind);
  } finally {
    await db.$disconnect();
  }
}

void main();
