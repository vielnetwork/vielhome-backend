import { Prisma } from '@prisma/client';

/** Invoked inside the business transaction. No R2 or Redis access. */
export async function enqueueDocumentBackup(
  tx: Prisma.TransactionClient,
  version: { id: string; fileUrl: string; fileSize: number; uploadedAt: Date },
  bucket = process.env.STORAGE_BUCKET,
): Promise<void> {
  // Preserve legacy non-storage development flows. Runner secrets are never read here.
  if (!bucket) return;
  await tx.objectBackupRequest.create({
    data: {
      sourceBucket: bucket,
      sourceKey: version.fileUrl,
      referenceType: 'DOCUMENT_VERSION',
      referenceId: version.id,
      expectedSize: BigInt(version.fileSize),
      finalizedAt: version.uploadedAt,
    },
  });
}
