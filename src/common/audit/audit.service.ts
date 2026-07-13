import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordAuditInput {
  actorId?: string | null;
  buildingId?: string | null;
  action: string; // e.g. "BuildingCreated" — matches domain event names
  entityType: string;
  entityId: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export interface SearchAuditInput {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  buildingId?: string;
  fromDate?: Date;
  toDate?: Date;
  take?: number;
  skip?: number;
}

/**
 * Every important business action records Who/When/What/Why and is
 * immutable (03_Core_Principles > Principle 6, 11_Backend_Architecture >
 * Audit). Rows are append-only: this service never updates or deletes.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          buildingId: input.buildingId ?? null,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          reason: input.reason,
          metadata: input.metadata as never,
          requestId: input.requestId,
        },
      });
    } catch (err) {
      // Audit failures must never break the primary business operation,
      // but they must never be silent either.
      this.logger.error(
        `Failed to write audit log for action=${input.action} entity=${input.entityType}:${input.entityId}`,
        (err as Error)?.stack,
      );
    }
  }

  /**
   * Minimal Audit Center read endpoint (10.05.05 Rule 007 — Platform
   * Admin only, filterable by entity_type/entity_id/actor_user_id/date
   * range). Introduced in ADR-029; the fuller Audit & Compliance Center
   * (07.06: timeline/export/metrics below) was added in ADR-034.
   */
  search(filters: SearchAuditInput) {
    return this.prisma.auditLog.findMany({
      where: {
        entityType: filters.entityType,
        entityId: filters.entityId,
        actorId: filters.actorId,
        buildingId: filters.buildingId,
        createdAt:
          filters.fromDate || filters.toDate
            ? { gte: filters.fromDate, lte: filters.toDate }
            : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: filters.take ?? 50,
      skip: filters.skip ?? 0,
    });
  }

  /**
   * 07.06 Rule 013 — "Audit Records Support Timeline Reconstruction": the
   * full, chronological history of everything recorded against one
   * entity. Ascending order (oldest first) since a timeline reads
   * naturally start-to-end, unlike `search`'s newest-first log view.
   * There is no separate `DomainSnapshot` table (10.04.07) this sprint —
   * see 21_ADRs > ADR-034 Context/Decision for why the reconstruction is
   * built directly on `AuditLog`'s already-immutable rows instead.
   */
  getTimeline(entityType: string, entityId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * 07.06 Rule 014 — "Audit Records May Be Exported." MVP formats are CSV
   * and PDF Report; only CSV is implemented this sprint — PDF generation
   * needs a real PDF library, which is not among this project's installed
   * dependencies (see 21_ADRs > ADR-034 Decision/Future Review). This
   * generates and returns a CSV string synchronously — no persisted file,
   * no object-storage dependency (the same S3/MinIO gap Documents MVP
   * already disclosed), the caller streams it directly in the HTTP
   * response.
   */
  async exportCsv(filters: SearchAuditInput): Promise<string> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        entityType: filters.entityType,
        entityId: filters.entityId,
        actorId: filters.actorId,
        buildingId: filters.buildingId,
        createdAt:
          filters.fromDate || filters.toDate
            ? { gte: filters.fromDate, lte: filters.toDate }
            : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: filters.take ?? 5000,
      skip: filters.skip ?? 0,
    });

    const header = [
      'id',
      'createdAt',
      'actorId',
      'buildingId',
      'action',
      'entityType',
      'entityId',
      'reason',
      'requestId',
    ];
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.createdAt.toISOString(),
          row.actorId,
          row.buildingId,
          row.action,
          row.entityType,
          row.entityId,
          row.reason,
          row.requestId,
        ]
          .map(escape)
          .join(','),
      );
    }
    return lines.join('\n');
  }

  /**
   * 07.06 Rule 019/020 — "Audit Metrics May Be Calculated" / "Compliance
   * Dashboard May Aggregate Audit Metrics." `action`/`entityType` are
   * free-text (no shared category column — adding one would need a
   * backfill migration across every historical row, see ADR-034
   * Context), so metrics are grouped by `entityType`, which already
   * separates domains reasonably well in practice (FraudCase/
   * EnforcementAction, BuildingVerificationCase/ManagerVerificationCase,
   * Fund/ChargeBatch/Payment, etc.) without inventing a new column.
   */
  async getMetrics(fromDate?: Date, toDate?: Date) {
    const where = fromDate || toDate ? { createdAt: { gte: fromDate, lte: toDate } } : undefined;
    const grouped = await this.prisma.auditLog.groupBy({
      by: ['entityType'],
      where,
      _count: { entityType: true },
      orderBy: { _count: { entityType: 'desc' } },
    });
    const total = grouped.reduce((sum, g) => sum + g._count.entityType, 0);
    return {
      total,
      byEntityType: grouped.map((g) => ({ entityType: g.entityType, count: g._count.entityType })),
    };
  }
}
