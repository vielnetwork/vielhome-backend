import { PrismaClient, Prisma } from '@prisma/client';
import { BackupStorage, BackupError } from './backup.storage';

/** Aggregate all document versions, including receipts and archived versions.
 * No raw keys, identifiers, or provider exceptions enter monitoring output. */
export async function backupMetrics(db: PrismaClient, bucket: string, now = new Date()) {
  const rows = await db.$queryRaw<
    Array<{ unprotected: bigint; oldest: Date | null; failed: bigint; overdue: bigint }>
  >(Prisma.sql`
    SELECT count(*) FILTER (WHERE NOT protected) AS unprotected,
      min("uploadedAt") FILTER (WHERE NOT protected) AS oldest,
      count(*) FILTER (WHERE state IN ('FAILED','SOURCE_MISSING')) AS failed,
      count(*) FILTER (WHERE NOT protected AND "uploadedAt" < ${new Date(now.getTime() - 900000)}) AS overdue
    FROM (
      SELECT v."uploadedAt", r.state,
        (r.state = 'VERIFIED' AND EXISTS (
          SELECT 1 FROM object_backup_generations g WHERE g."requestId"=r.id
            AND g."verifiedAt" IS NOT NULL AND g.sha256 ~ '^[a-f0-9]{64}$'
            AND g."observedSize" IS NOT NULL AND g."sourceETag" IS NOT NULL
        )) IS TRUE AS protected
      FROM document_versions v LEFT JOIN object_backup_requests r
        ON r."referenceType"='DOCUMENT_VERSION' AND r."referenceId"=v.id
        AND r."sourceBucket"=${bucket} AND r."sourceKey"=v."fileUrl"
    ) coverage`);
  const r = rows[0];
  if (!r) throw new Error('BACKUP_METRICS_UNAVAILABLE');
  return {
    unprotectedCount: Number(r.unprotected),
    oldestUnprotectedAgeSeconds: r.oldest
      ? Math.max(0, Math.floor((now.getTime() - r.oldest.getTime()) / 1000))
      : 0,
    failedCount: Number(r.failed),
    overdueCount: Number(r.overdue),
  };
}

/** Read-only reconciliation. Repair is intentionally a separate reviewed action. */
export async function reconcile(
  db: PrismaClient,
  bucket: string,
  storage: BackupStorage,
  canContinue: () => boolean = () => true,
) {
  const report = {
    missingRequests: 0,
    overdueRequests: 0,
    invalidVerifiedMetadata: 0,
    missingSources: 0,
    sourceCheckFailures: 0,
    conflictingGenerations: 0,
  };
  let cursor: string | undefined;
  while (true) {
    if (!canContinue()) throw new Error('RECONCILIATION_STOPPED');
    const versions = await db.documentVersion.findMany({
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!versions.length) break;
    for (const v of versions) {
      if (!canContinue()) throw new Error('RECONCILIATION_STOPPED');
      const r = await db.objectBackupRequest.findUnique({
        where: {
          sourceBucket_referenceType_referenceId: {
            sourceBucket: bucket,
            referenceType: 'DOCUMENT_VERSION',
            referenceId: v.id,
          },
        },
        include: { generations: true },
      });
      const matching = r?.sourceKey === v.fileUrl;
      if (!r || !matching) report.missingRequests++;
      const verified = r?.generations.filter((g) => g.verifiedAt !== null) ?? [];
      const complete = verified.filter(
        (g) =>
          g.sha256 &&
          /^[a-f0-9]{64}$/.test(g.sha256) &&
          g.observedSize !== null &&
          g.sourceETag &&
          g.backupKey &&
          g.manifestKey,
      );
      if (
        r?.state === 'VERIFIED' &&
        (!matching || complete.length === 0 || complete.length !== verified.length)
      )
        report.invalidVerifiedMetadata++;
      if (new Set(verified.map((g) => g.sha256)).size > 1) report.conflictingGenerations++;
      if (!matching || r?.state !== 'VERIFIED' || complete.length === 0) {
        if (Date.now() - v.uploadedAt.getTime() > 900000) report.overdueRequests++;
        try {
          await storage.headSource(v.fileUrl);
        } catch (e) {
          if (e instanceof BackupError && e.code === 'SOURCE_MISSING') report.missingSources++;
          else report.sourceCheckFailures++;
        }
      }
    }
    cursor = versions[versions.length - 1].id;
  }
  return report;
}
