import { ObjectBackupGeneration, ObjectBackupRequest } from '@prisma/client';
import { SourceIdentity } from './backup.storage';
export function manifest(
  request: ObjectBackupRequest,
  generation: ObjectBackupGeneration,
  source: SourceIdentity,
  sha256: string,
  environment: string,
  verifiedAt: Date,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      manifestVersion: 1,
      environment,
      source: {
        bucket: request.sourceBucket,
        key: request.sourceKey,
        size: source.size,
        etag: source.etag,
        lastModified: source.lastModified,
      },
      reference: { type: request.referenceType, id: request.referenceId },
      sha256,
      destination: { bucket: generation.backupBucket, key: generation.backupKey },
      captureId: generation.captureId,
      backupTimestamp: generation.createdAt.toISOString(),
      verificationTimestamp: verifiedAt.toISOString(),
    }),
  );
}
