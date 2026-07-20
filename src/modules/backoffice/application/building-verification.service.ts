import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { BuildingVerificationDecision, VerificationPriority } from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { BuildingVerificationPolicy } from '../domain/policies/building-verification.policy';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';
import { BuildingVerificationDecidedEvent } from '../events/backoffice.events';

const DECISION_TO_STATUS: Record<
  BuildingVerificationDecision,
  'VERIFIED' | 'REJECTED' | 'PENDING_INFORMATION'
> = {
  APPROVE: 'VERIFIED',
  REJECT: 'REJECTED',
  REQUEST_INFORMATION: 'PENDING_INFORMATION',
};

/**
 * Building Verification Queue (07.01 — see 21_ADRs > ADR-029). The single
 * entry point `BackOfficeEventListener` calls on every new building, and
 * the service behind the BackOffice staff queue endpoints + the building
 * creator's appeal endpoint.
 */
@Injectable()
export class BuildingVerificationService {
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly policy: BuildingVerificationPolicy,
    private readonly buildings: BuildingRepository,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * 07.01 Rule 001-003: every new building gets a risk score; a
   * risk-free building is auto-approved (`VERIFIED`) with no queue wait,
   * anything else is queued (`UNDER_REVIEW`) for a human decision. Always
   * creates a case either way — Rule 009/020 (all decisions audited, case
   * history preserved) apply even to the auto-approved path.
   */
  async evaluateNewBuilding(params: {
    buildingId: string;
    city: string;
    district: string;
    mainStreet: string;
    createdById: string;
  }): Promise<void> {
    const similar = await this.buildings.findSimilarAddressBuildings({
      city: params.city,
      district: params.district,
      mainStreet: params.mainStreet,
      excludeBuildingId: params.buildingId,
      excludeCreatedById: params.createdById,
    });
    const risk = this.policy.evaluateRisk(similar.length > 0);
    const autoApproved = this.policy.isAutoApproved(risk.score);
    const status = autoApproved ? 'VERIFIED' : 'UNDER_REVIEW';
    const priority: VerificationPriority = risk.score >= 50 ? 'HIGH' : 'NORMAL';

    const kase = await this.backOffice.createBuildingVerificationCase({
      buildingId: params.buildingId,
      status,
      priority,
      riskScore: risk.score,
      riskFlags: risk.flags,
      decision: autoApproved ? 'APPROVE' : undefined,
      reason: autoApproved ? 'Auto-approved: no risk flags.' : undefined,
      decidedAt: autoApproved ? new Date() : undefined,
    });

    await this.buildings.updateBuildingStatus(params.buildingId, status);

    await this.audit.record({
      buildingId: params.buildingId,
      action: autoApproved ? 'BuildingVerificationAutoApproved' : 'BuildingVerificationQueued',
      entityType: 'BuildingVerificationCase',
      entityId: kase.id,
      metadata: { riskScore: risk.score, riskFlags: risk.flags },
    });

    if (autoApproved) {
      this.events.emit(
        'BuildingVerificationDecided',
        new BuildingVerificationDecidedEvent(
          params.buildingId,
          kase.id,
          status,
          params.createdById,
        ),
      );
    }
  }

  async getCase(caseId: string) {
    const kase = await this.backOffice.findBuildingVerificationCaseById(caseId);
    if (!kase) throw new NotFoundAppError('Building verification case not found.');
    return kase;
  }

  /** 21_ADRs > ADR-072 */
  async listCases(
    filters: { status?: string; priority?: string; assignedToId?: string },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.backOffice.listBuildingVerificationCases(
      {
        status: filters.status as never,
        priority: filters.priority as never,
        assignedToId: filters.assignedToId,
      },
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async assignCase(caseId: string, assigneeId: string, actorPersonId: string, requestId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertDecidable(kase.status);

    const updated = await this.backOffice.assignBuildingVerificationCase(caseId, assigneeId);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId: kase.buildingId,
      action: 'BuildingVerificationAssigned',
      entityType: 'BuildingVerificationCase',
      entityId: caseId,
      requestId,
      metadata: { assigneeId },
    });

    return updated;
  }

  async decideCase(
    caseId: string,
    decision: BuildingVerificationDecision,
    reviewerPersonId: string,
    reason: string | undefined,
    requestId: string,
  ) {
    const kase = await this.getCase(caseId);
    this.policy.assertDecidable(kase.status);

    const status = DECISION_TO_STATUS[decision];
    const updated = await this.backOffice.decideBuildingVerificationCase({
      id: caseId,
      status,
      decision,
      reviewedById: reviewerPersonId,
      reason,
    });

    await this.buildings.updateBuildingStatus(kase.buildingId, status);

    await this.audit.record({
      actorId: reviewerPersonId,
      buildingId: kase.buildingId,
      action: 'BuildingVerificationDecided',
      entityType: 'BuildingVerificationCase',
      entityId: caseId,
      requestId,
      reason,
      metadata: { decision },
    });

    if (status === 'VERIFIED' || status === 'REJECTED') {
      this.events.emit(
        'BuildingVerificationDecided',
        new BuildingVerificationDecidedEvent(
          kase.buildingId,
          caseId,
          status,
          kase.building.createdById,
        ),
      );
    }

    return updated;
  }

  /** 07.01 Rule 014/015 — the building's own creator, on a rejected case, opens a new case that links back to the old one via `previousCaseId`. No fresh risk evaluation is run — an appeal always goes to manual review, never back through auto-approval. */
  async appealCase(
    buildingId: string,
    callerPersonId: string,
    reason: string | undefined,
    requestId: string,
  ) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');

    const latest = await this.backOffice.getLatestBuildingVerificationCase(buildingId);
    if (!latest) throw new NotFoundAppError('No verification case found for this building.');

    this.policy.assertCanAppeal(latest.status, callerPersonId, building.createdById);

    const appeal = await this.backOffice.createBuildingVerificationCase({
      buildingId,
      status: 'UNDER_REVIEW',
      priority: 'NORMAL',
      riskScore: latest.riskScore,
      riskFlags: latest.riskFlags,
      isAppeal: true,
      previousCaseId: latest.id,
    });

    await this.buildings.updateBuildingStatus(buildingId, 'UNDER_REVIEW');

    await this.audit.record({
      actorId: callerPersonId,
      buildingId,
      action: 'BuildingVerificationAppealed',
      entityType: 'BuildingVerificationCase',
      entityId: appeal.id,
      requestId,
      reason,
      metadata: { previousCaseId: latest.id },
    });

    return appeal;
  }
}
