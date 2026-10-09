import { Prisma, type PrismaClient } from '@prisma/client';
import { assertAdminProof, type AdminProof } from '@/lib/admin-access';

/** Platform-wide counts for the admin dashboard. Aggregates only; the parts are returned and no total field is. */
export interface PlatformCounts {
  teachers: number;
  students: { withAccount: number; walkInOnly: number };
  rooms: { public: number; private: number };
}

export async function getPlatformCounts(proof: AdminProof, db: PrismaClient): Promise<PlatformCounts> {
  assertAdminProof(proof);
  // Repeatable Read so the batch reads one snapshot; at Read Committed each statement takes its own.
  const [teachers, withAccount, walkInOnly, publicRooms, privateRooms] = await db.$transaction(
    [
      db.teacher.count({ where: { deletedAt: null } }),
      db.student.count({ where: { deletedAt: null, accountId: { not: null } } }),
      db.student.count({ where: { deletedAt: null, accountId: null } }),
      db.room.count({ where: { isPublic: true } }),
      db.room.count({ where: { isPublic: false } }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return {
    teachers,
    students: { withAccount, walkInOnly },
    rooms: { public: publicRooms, private: privateRooms },
  };
}
