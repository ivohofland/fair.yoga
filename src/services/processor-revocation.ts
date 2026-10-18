import type { PrismaClient } from '@/lib/prisma-client';
import { log } from '@/lib/log';
import { mollieDeps, type MollieDeps } from './mollie-deps';
import { revokeDueConnection } from './processor-connection';

export type RevocationReport = { revoked: number; failed: number; skipped: number };

/**
 * Thrown by `revokeDueConnections` when it found due rows and every one failed,
 * so the job's verdict reports a sweep that revoked nothing. It carries the
 * report. Rows that did get revoked, or were skipped, keep a run quiet.
 */
export class RevocationFailedError extends Error {
  readonly report: RevocationReport;

  constructor(report: RevocationReport) {
    super(`processor revocation attempted ${report.failed} connection(s) and every one failed`);
    this.name = 'RevocationFailedError';
    this.report = report;
  }
}

/**
 * The daily sweep behind `disconnect`'s `revokeAfter`: revokes at Mollie every
 * disconnected connection whose window has passed and that still holds its
 * grant, one row at a time through `revokeDueConnection`, which owns the
 * guarded write that keeps a reconnect's new grant.
 *
 * `revoked` rows had their tokens nulled and `revokedAt` stamped. `failed`
 * rows stay due for the next run: Mollie could not be reached, the stored
 * token could not be opened, or the row raised something unexpected (logged
 * here, and it does not stop the rows after it). `skipped` rows were due when
 * read and not revoked: all of them when Mollie is not configured (`deps` is
 * null), otherwise the ones a reconnect or another revoke took first. When
 * every due row failed it throws `RevocationFailedError` instead of returning.
 */
export async function revokeDueConnections(
  db: PrismaClient,
  now: Date = new Date(),
  deps: MollieDeps | null = mollieDeps(),
): Promise<RevocationReport> {
  const due = await db.processorConnection.findMany({
    where: { disconnectedAt: { not: null }, revokedAt: null, revokeAfter: { lte: now } },
    select: { id: true },
    orderBy: { revokeAfter: 'asc' },
  });
  const report: RevocationReport = { revoked: 0, failed: 0, skipped: 0 };
  if (deps === null) {
    report.skipped = due.length;
    return report;
  }
  for (const { id } of due) {
    try {
      const outcome = await revokeDueConnection(db, deps, id, now);
      switch (outcome) {
        case 'revoked':
          report.revoked += 1;
          break;
        case 'unavailable':
          report.failed += 1;
          break;
        case 'skipped':
          report.skipped += 1;
          break;
        default: {
          const unreachable: never = outcome;
          throw new Error(`unhandled revoke outcome ${String(unreachable)}`);
        }
      }
    } catch (err) {
      log.error({ err, connectionId: id }, 'processor revoke sweep: a connection failed unexpectedly');
      report.failed += 1;
    }
  }
  if (report.failed > 0 && report.revoked === 0 && report.skipped === 0) throw new RevocationFailedError(report);
  return report;
}
