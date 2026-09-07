import { randomUUID } from 'crypto';
import { ObjectBackupRequest, ObjectBackupGeneration, PrismaClient } from '@prisma/client';
import { BackupError } from './backup.storage';

export class BackupRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly sourceBucket: string,
  ) {}
  async claim(now = new Date()): Promise<ObjectBackupRequest | null> {
    const eligible = {
      sourceBucket: this.sourceBucket,
      OR: [
        {
          state: {
            in: ['PENDING', 'FAILED', 'SOURCE_MISSING'] as (
              'PENDING' | 'FAILED' | 'SOURCE_MISSING'
            )[],
          },
          nextAttemptAt: { lte: now },
          attempts: { lt: 10 },
        },
        { state: 'COPYING' as const, leaseUntil: { lte: now } },
      ],
    };
    const candidates = await this.db.objectBackupRequest.findMany({
      where: eligible,
      orderBy: { finalizedAt: 'asc' },
      take: 25,
    });
    for (const candidate of candidates) {
      const owner = randomUUID();
      // Compare-and-set is one database UPDATE, not a read-then-unconditional-write.
      const won = await this.db.objectBackupRequest.updateMany({
        where: { id: candidate.id, ...eligible },
        data: {
          state: 'COPYING',
          leaseOwner: owner,
          leaseUntil: new Date(now.getTime() + 600000),
          attempts: { increment: 1 },
          failureCode: null,
        },
      });
      if (won.count === 1)
        return this.db.objectBackupRequest.findUniqueOrThrow({ where: { id: candidate.id } });
    }
    return null;
  }
  createGeneration(request: ObjectBackupRequest, bucket: string) {
    const captureId = randomUUID();
    return this.db.objectBackupGeneration.create({
      data: {
        requestId: request.id,
        captureId,
        backupBucket: bucket,
        backupKey: `objects/v1/${request.id}/${captureId}`,
        manifestKey: `manifests/v1/${request.id}/${captureId}.json`,
      },
    });
  }
  async verify(
    request: ObjectBackupRequest,
    generation: ObjectBackupGeneration,
    data: {
      sourceETag: string;
      sourceLastModified: string;
      observedSize: bigint;
      sha256: string;
      verifiedAt: Date;
    },
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const updated = await tx.objectBackupRequest.updateMany({
        where: {
          id: request.id,
          state: 'COPYING',
          leaseOwner: request.leaseOwner,
          leaseUntil: { gt: new Date() },
        },
        data: { state: 'VERIFIED', leaseOwner: null, leaseUntil: null, failureCode: null },
      });
      if (updated.count !== 1) throw new BackupError('LEASE_LOST');
      await tx.objectBackupGeneration.update({ where: { id: generation.id }, data });
    });
  }
  async fail(request: ObjectBackupRequest, code: string): Promise<void> {
    const seconds = Math.min(300, 30 * 2 ** Math.min(request.attempts - 1, 4));
    await this.db.objectBackupRequest.updateMany({
      where: { id: request.id, state: 'COPYING', leaseOwner: request.leaseOwner },
      data: {
        state: code === 'SOURCE_MISSING' ? 'SOURCE_MISSING' : 'FAILED',
        failureCode: code,
        leaseUntil: null,
        leaseOwner: null,
        nextAttemptAt: new Date(Date.now() + seconds * 1000),
      },
    });
  }
}
