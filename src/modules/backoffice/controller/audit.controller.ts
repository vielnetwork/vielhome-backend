import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../../../common/audit/audit.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Audit & Compliance Center (10.05.05 Rule 007 + 07.06 — see 21_ADRs >
 * ADR-029 for the minimal `search` endpoint, ADR-034 for `timeline`/
 * `export`/`metrics`). Raw log search/timeline/export stay
 * `PLATFORM_ADMIN`-only, unchanged from ADR-029's own resolution of the
 * "Admin Only" (10.05.05) vs. broader-Actors-list (07.06) tension;
 * `metrics` is opened to `SENIOR_REVIEWER`+ since aggregate counts are
 * less sensitive than raw before/after row data — see ADR-034 Decision.
 *
 * 07.06 Rule 017 — "Sensitive Audit Access Must Be Audited": every read
 * here also writes its own `AuditLog` row (action `AuditLogAccessed`/
 * `AuditLogExported`), the meta-audit rule.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/audit-logs', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @PlatformRoles('PLATFORM_ADMIN')
  async search(
    @Query('entityType') entityType: string | undefined,
    @Query('entityId') entityId: string | undefined,
    @Query('actorId') actorId: string | undefined,
    @Query('buildingId') buildingId: string | undefined,
    @Query('fromDate') fromDate: string | undefined,
    @Query('toDate') toDate: string | undefined,
    @Query('take') take: string | undefined,
    @Query('skip') skip: string | undefined,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    const filters = {
      entityType,
      entityId,
      actorId,
      buildingId,
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    };
    const results = await this.audit.search(filters);
    await this.recordAccess('AuditLogAccessed', user.sub, requestId, filters);
    return results;
  }

  /** 07.06 Rule 013 — Timeline Reconstruction for a single entity. */
  @Get('timeline')
  @PlatformRoles('PLATFORM_ADMIN')
  async timeline(
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    const results = await this.audit.getTimeline(entityType, entityId);
    await this.recordAccess('AuditLogAccessed', user.sub, requestId, { entityType, entityId, view: 'timeline' });
    return results;
  }

  /**
   * 07.06 Rule 014 — CSV export (PDF is deferred, see
   * `AuditService.exportCsv`'s own comment). Uses a non-passthrough
   * `@Res()` deliberately: the global `ResponseInterceptor`
   * (`main.ts` > `app.useGlobalInterceptors`) wraps every normal
   * controller return value in the standard JSON envelope, which would
   * corrupt a downloadable CSV file. Injecting `@Res()` without
   * `{ passthrough: true }` tells Nest this handler owns the response —
   * the interceptor still runs but its transformed output is simply
   * never sent, since the response was already ended manually below.
   */
  @Get('export')
  @PlatformRoles('PLATFORM_ADMIN')
  async export(
    @Query('entityType') entityType: string | undefined,
    @Query('entityId') entityId: string | undefined,
    @Query('actorId') actorId: string | undefined,
    @Query('buildingId') buildingId: string | undefined,
    @Query('fromDate') fromDate: string | undefined,
    @Query('toDate') toDate: string | undefined,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
    @Res() res: Response,
  ): Promise<void> {
    const filters = {
      entityType,
      entityId,
      actorId,
      buildingId,
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
    };
    const csv = await this.audit.exportCsv(filters);
    await this.recordAccess('AuditLogExported', user.sub, requestId, filters);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log-export.csv"');
    res.send(csv);
  }

  /** 07.06 Rule 019/020 — aggregate Compliance Dashboard metrics. */
  @Get('metrics')
  @PlatformRoles('SENIOR_REVIEWER')
  async metrics(
    @Query('fromDate') fromDate: string | undefined,
    @Query('toDate') toDate: string | undefined,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    const results = await this.audit.getMetrics(fromDate ? new Date(fromDate) : undefined, toDate ? new Date(toDate) : undefined);
    await this.recordAccess('AuditLogAccessed', user.sub, requestId, { view: 'metrics' });
    return results;
  }

  private recordAccess(action: 'AuditLogAccessed' | 'AuditLogExported', actorId: string, requestId: string, metadata: Record<string, unknown>) {
    return this.audit.record({
      actorId,
      action,
      entityType: 'AuditLog',
      entityId: 'search',
      requestId,
      metadata,
    });
  }
}
