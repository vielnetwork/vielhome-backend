import { PrismaClient, Prisma } from '@prisma/client';

/** Request-level coverage includes synthetic and non-document references. */
export async function queueMetrics(db: PrismaClient, bucket: string, now = new Date()) {
  const rows = await db.$queryRaw<Array<Record<string, bigint | number | Date | null>>>(Prisma.sql`
    WITH coverage AS (
      SELECT r.*,
        (r.state = 'VERIFIED' AND g.valid > 0 AND g.invalid = 0 AND g.hashes = 1) AS protected,
        g.first_verified,
        (r.state = 'VERIFIED' AND NOT (g.valid > 0 AND g.invalid = 0 AND g.hashes = 1)) AS invalid_verified
      FROM object_backup_requests r
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE "verifiedAt" IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$'
          AND "observedSize" IS NOT NULL AND "sourceETag" IS NOT NULL AND "verifiedAt" >= r."finalizedAt") AS valid,
          count(*) FILTER (WHERE "verifiedAt" IS NOT NULL AND
            (sha256 IS NULL OR sha256 !~ '^[a-f0-9]{64}$' OR "observedSize" IS NULL OR "sourceETag" IS NULL OR "verifiedAt" < r."finalizedAt")) AS invalid,
          count(DISTINCT sha256) FILTER (WHERE "verifiedAt" IS NOT NULL) AS hashes,
          min("verifiedAt") FILTER (WHERE "verifiedAt" IS NOT NULL) AS first_verified
        FROM object_backup_generations WHERE "requestId" = r.id
      ) g WHERE r."sourceBucket" = ${bucket}
    )
    SELECT count(*) AS total,
      count(*) FILTER (WHERE state = 'PENDING') AS pending,
      count(*) FILTER (WHERE state = 'COPYING') AS copying,
      count(*) FILTER (WHERE NOT protected) AS unprotected,
      min("finalizedAt") FILTER (WHERE NOT protected) AS oldest,
      count(*) FILTER (WHERE state = 'FAILED') AS failed,
      count(*) FILTER (WHERE state = 'SOURCE_MISSING') AS missing,
      count(*) FILTER (WHERE state IN ('PENDING','FAILED','SOURCE_MISSING') AND attempts >= 10) AS exhausted,
      count(*) FILTER (WHERE state = 'COPYING' AND "leaseUntil" > ${now} AND "leaseOwner" IS NOT NULL) AS active,
      count(*) FILTER (WHERE state = 'COPYING' AND "leaseUntil" <= ${now}) AS expired,
      count(*) FILTER (WHERE state = 'COPYING' AND ("leaseUntil" IS NULL OR "leaseOwner" IS NULL)) AS invalid_lease,
      count(*) FILTER (WHERE state = 'VERIFIED') AS verified,
      count(*) FILTER (WHERE invalid_verified) AS invalid_verified,
      count(*) FILTER (WHERE NOT protected AND "finalizedAt" < ${new Date(now.getTime() - 900000)}) AS overdue,
      count(*) FILTER (WHERE protected) AS measured,
      max(extract(epoch FROM (first_verified - "finalizedAt"))) FILTER (WHERE protected)::double precision AS max_latency,
      count(*) FILTER (WHERE protected AND first_verified - "finalizedAt" > interval '15 minutes') AS late_verified
    FROM coverage`);
  const r = rows[0];
  if (!r) throw new Error('QUEUE_METRICS_UNAVAILABLE');
  const number = (key: string) => {
    const v = Number(r[key]);
    if (r[key] === null || r[key] === undefined || !Number.isSafeInteger(v) || v < 0)
      throw new Error('QUEUE_METRICS_INVALID');
    return v;
  };
  const latency = r.max_latency === null ? null : Number(r.max_latency);
  if (latency !== null && (!Number.isFinite(latency) || latency < 0))
    throw new Error('QUEUE_METRICS_INVALID');
  const oldest = r.oldest === null ? null : new Date(r.oldest as Date);
  if (oldest && !Number.isFinite(oldest.getTime())) throw new Error('QUEUE_METRICS_INVALID');
  return {
    totalCount: number('total'),
    pendingCount: number('pending'),
    copyingCount: number('copying'),
    unprotectedCount: number('unprotected'),
    oldestUnprotectedAgeSeconds: oldest
      ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000))
      : 0,
    failedCount: number('failed'),
    sourceMissingCount: number('missing'),
    exhaustedCount: number('exhausted'),
    activeLeaseCount: number('active'),
    expiredLeaseCount: number('expired'),
    invalidLeaseCount: number('invalid_lease'),
    verifiedCount: number('verified'),
    invalidVerifiedCount: number('invalid_verified'),
    overdueCount: number('overdue'),
    measuredProtectionCount: number('measured'),
    maxProtectionLatencySeconds: latency,
    lateVerifiedCount: number('late_verified'),
  };
}
