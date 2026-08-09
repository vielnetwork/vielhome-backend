import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  EnforcementActionType,
  EnforcementTargetType,
  FraudCaseStatus,
  FraudSignalType,
  VerificationPriority,
} from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { FraudCasePolicy } from '../domain/policies/fraud-case.policy';
import { AuditService } from '../../../common/audit/audit.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';
import { EnforcementActionIssuedEvent, FraudCaseDecidedEvent } from '../events/backoffice.events';
import { PermissionResolverService } from '../../backoffice-rbac/application/permission-resolver.service';

/**
 * Fraud & Abuse Center (07.03_Fraud_And_Abuse_Center_v1.0 — see 21_ADRs >
 * ADR-031). Covers Rules 001-019's case/enforcement/appeal lifecycle; Rule
 * 001's automatic signal detection is still explicitly out of scope (see
 * the schema section header comment). Rule 020's analytics are now covered
 * by `getMetrics` (21_ADRs > ADR-050). `enforce()`'s own per-severity role
 * check (21_ADRs > ADR-044) is the one place in this service that resolves
 * the caller's exact `PlatformStaffRole` itself rather than trusting the
 * controller's route-level `@PlatformRoles(...)` gate alone.
 */
@Injectable()
export class FraudCaseService {
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly policy: FraudCasePolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly permissions: PermissionResolverService,
  ) {}

  /** 07.03 Rule 002 — any authenticated Person may report; see ReportFraudDto's header note on the deferred authorized-reporter role gate. */
  async report(
    params: { targetPersonId?: string; targetBuildingId?: string; description: string },
    reporterPersonId: string,
    requestId: string,
  ) {
    if (!params.targetPersonId && !params.targetBuildingId) {
      throw new ValidationError('A fraud report must target either a person or a building.');
    }

    const kase = await this.backOffice.createFraudCase({
      source: 'USER_REPORT',
      priority: 'NORMAL',
      reportedById: reporterPersonId,
      targetPersonId: params.targetPersonId,
      targetBuildingId: params.targetBuildingId,
      description: params.description,
    });

    await this.audit.record({
      actorId: reporterPersonId,
      action: 'FraudCaseReported',
      entityType: 'FraudCase',
      entityId: kase.id,
      requestId,
      metadata: {
        targetPersonId: params.targetPersonId,
        targetBuildingId: params.targetBuildingId,
      },
    });

    return kase;
  }

  /** 07.03 Rule 001 — staff opens a case standing in for the not-yet-built automatic signal detector. */
  async openCase(
    params: {
      signalType: FraudSignalType;
      targetPersonId?: string;
      targetBuildingId?: string;
      priority?: VerificationPriority;
      description?: string;
    },
    staffPersonId: string,
    requestId: string,
  ) {
    if (!params.targetPersonId && !params.targetBuildingId) {
      throw new ValidationError('A fraud case must target either a person or a building.');
    }

    const kase = await this.backOffice.createFraudCase({
      source: 'SYSTEM_SIGNAL',
      signalType: params.signalType,
      priority: params.priority ?? 'NORMAL',
      targetPersonId: params.targetPersonId,
      targetBuildingId: params.targetBuildingId,
      description: params.description,
    });

    await this.audit.record({
      actorId: staffPersonId,
      action: 'FraudCaseOpened',
      entityType: 'FraudCase',
      entityId: kase.id,
      requestId,
      metadata: { signalType: params.signalType },
    });

    return kase;
  }

  async getCase(caseId: string) {
    const kase = await this.backOffice.findFraudCaseById(caseId);
    if (!kase) throw new NotFoundAppError('Fraud case not found.');
    return kase;
  }

  /** 21_ADRs > ADR-072 */
  async listCases(
    filters: { status?: FraudCaseStatus; priority?: VerificationPriority; assignedToId?: string },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.backOffice.listFraudCases(
      {
        status: filters.status,
        priority: filters.priority,
        assignedToId: filters.assignedToId,
      },
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  /** 07.03 Rule 017 (staff queue) — assigning an investigator moves the case from OPEN to UNDER_INVESTIGATION. */
  async assignCase(caseId: string, assigneeId: string, actorPersonId: string, requestId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertInvestigable(kase.status);
    const granted = await this.permissions.resolve(assigneeId);
    if (!granted.has('FRAUD_MANAGE')) {
      throw new ValidationError('The assignee must be active platform staff with FRAUD_MANAGE.');
    }

    const updated = await this.backOffice.assignFraudCase(caseId, assigneeId, kase.status);

    await this.audit.record({
      actorId: actorPersonId,
      action: 'FraudCaseAssigned',
      entityType: 'FraudCase',
      entityId: caseId,
      requestId,
      metadata: { assigneeId },
    });

    return updated;
  }

  /** 07.03 Rule 005 — Evidence Aggregation notes, appended during investigation. */
  async addEvidence(
    caseId: string,
    evidenceNotes: string,
    actorPersonId: string,
    requestId: string,
  ) {
    const kase = await this.getCase(caseId);
    this.policy.assertInvestigable(kase.status);

    const updated = await this.backOffice.addFraudCaseEvidence(
      caseId,
      evidenceNotes,
      actorPersonId,
    );

    await this.audit.record({
      actorId: actorPersonId,
      action: 'FraudCaseEvidenceAdded',
      entityType: 'FraudCase',
      entityId: caseId,
      requestId,
      metadata: { evidenceId: updated.evidence.at(-1)?.id },
    });

    return updated;
  }

  /** 07.03 Rule 007/011: CONFIRM or DISMISS an investigated case. */
  async decideCase(
    caseId: string,
    decision: 'CONFIRM' | 'DISMISS',
    reviewerPersonId: string,
    reason: string | undefined,
    requestId: string,
  ) {
    const kase = await this.getCase(caseId);
    this.policy.assertInvestigable(kase.status);

    const status = decision === 'CONFIRM' ? 'CONFIRMED' : 'DISMISSED';
    const updated = await this.backOffice.decideFraudCase({
      id: caseId,
      status,
      reviewedById: reviewerPersonId,
      reason,
      expectedStatus: kase.status,
    });

    await this.audit.record({
      actorId: reviewerPersonId,
      action: 'FraudCaseDecided',
      entityType: 'FraudCase',
      entityId: caseId,
      requestId,
      reason,
      metadata: { decision },
    });

    this.events.emit(
      'FraudCaseDecided',
      new FraudCaseDecidedEvent(caseId, status, kase.reportedById ?? null),
    );

    return updated;
  }

  /** 07.03 Rule 016 — a closed case may be reopened given new evidence; creates a fresh linked case rather than mutating the old one. */
  async reopenCase(caseId: string, newEvidence: string, actorPersonId: string, requestId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertCanReopen(kase.status);

    const reopened = await this.backOffice.createFraudCase({
      source: kase.source,
      signalType: kase.signalType ?? undefined,
      priority: kase.priority,
      reportedById: kase.reportedById ?? undefined,
      targetPersonId: kase.targetPersonId ?? undefined,
      targetBuildingId: kase.targetBuildingId ?? undefined,
      description: newEvidence,
      isReopen: true,
      previousCaseId: kase.id,
    });

    await this.audit.record({
      actorId: actorPersonId,
      action: 'FraudCaseReopened',
      entityType: 'FraudCase',
      entityId: reopened.id,
      requestId,
      metadata: { previousCaseId: kase.id },
    });

    return reopened;
  }

  /**
   * 07.03 Rule 013/014/015/017 — an Enforcement Action may only be issued
   * against a CONFIRMED case. Where an existing repository method already
   * has a real system effect (Manager Claim revocation reuses
   * `suspendManagement`, same as BackOffice/ADR-029's own SUSPEND path;
   * Building revocation reuses `updateBuildingStatus`), this wires it;
   * WARNING/TEMPORARY_RESTRICTION are record-only for this MVP — see
   * 21_ADRs > ADR-031 Decision for the full list of what's enforced vs.
   * merely recorded.
   */
  async enforce(
    caseId: string,
    params: {
      type: EnforcementActionType;
      targetType: EnforcementTargetType;
      targetPersonId?: string;
      targetBuildingId?: string;
      targetMembershipId?: string;
      reason?: string;
    },
    issuedById: string,
    requestId: string,
  ) {
    const kase = await this.getCase(caseId);
    if (kase.status !== 'CONFIRMED') {
      throw new BusinessRuleViolationError(
        'Enforcement actions may only be issued against a CONFIRMED fraud case.',
      );
    }
    this.assertTargetMatchesType(params, kase);

    // 21_ADRs > ADR-044 — `FraudCaseController`'s own `@PlatformRoles
    // ('SENIOR_REVIEWER')` guard already confirmed the caller holds at
    // least that rank; this re-fetch resolves their EXACT rank so the
    // policy can apply the stricter ACCOUNT_SUSPENSION-only gate on top.
    // A second DB read per call, deliberately not threaded down from the
    // guard — see ADR-044 Decision for why that's the honest trade-off for
    // a single call site rather than new shared plumbing.
    const staff = await this.backOffice.getActivePlatformStaff(issuedById);
    if (!staff) {
      throw new AuthorizationError('This action requires platform staff access.');
    }
    this.policy.assertCanIssueEnforcement(params.type, staff.role);

    const { action, created } = await this.backOffice.createEnforcementActionWithEffect({
      fraudCaseId: caseId,
      type: params.type,
      targetType: params.targetType,
      targetPersonId: params.targetPersonId,
      targetBuildingId: params.targetBuildingId,
      targetMembershipId: params.targetMembershipId,
      reason: params.reason,
      issuedById,
      idempotencyKey: `${caseId}:${requestId}`,
    });

    if (!created) return action;

    await this.audit.record({
      actorId: issuedById,
      action: 'EnforcementActionIssued',
      entityType: 'EnforcementAction',
      entityId: action.id,
      requestId,
      reason: params.reason,
      metadata: { type: params.type, targetType: params.targetType },
    });

    if (params.targetPersonId) {
      this.events.emit(
        'EnforcementActionIssued',
        new EnforcementActionIssuedEvent(action.id, caseId, params.type, params.targetPersonId),
      );
    }

    return action;
  }

  private assertTargetMatchesType(
    params: {
      type: EnforcementActionType;
      targetType: EnforcementTargetType;
      targetPersonId?: string;
      targetBuildingId?: string;
      targetMembershipId?: string;
    },
    kase: { targetPersonId: string | null; targetBuildingId: string | null },
  ): void {
    if (params.type === 'ACCOUNT_SUSPENSION' && params.targetType !== 'PERSON') {
      throw new ValidationError('ACCOUNT_SUSPENSION may only target a PERSON.');
    }
    if (
      params.type === 'VERIFICATION_REVOCATION' &&
      params.targetType !== 'BUILDING' &&
      params.targetType !== 'MANAGER_CLAIM'
    ) {
      throw new ValidationError(
        'VERIFICATION_REVOCATION may only target a BUILDING or MANAGER_CLAIM.',
      );
    }
    if (params.targetType === 'PERSON') {
      if (!params.targetPersonId || params.targetBuildingId || params.targetMembershipId) {
        throw new ValidationError('PERSON requires only targetPersonId.');
      }
      if (kase.targetPersonId !== params.targetPersonId) {
        throw new ValidationError('The enforcement target must match the confirmed fraud case.');
      }
    }
    if (params.targetType === 'BUILDING') {
      if (!params.targetBuildingId || params.targetPersonId || params.targetMembershipId) {
        throw new ValidationError('BUILDING requires only targetBuildingId.');
      }
      if (kase.targetBuildingId !== params.targetBuildingId) {
        throw new ValidationError('The enforcement target must match the confirmed fraud case.');
      }
    }
    if (params.targetType === 'MANAGER_CLAIM') {
      if (!params.targetMembershipId || !params.targetBuildingId || params.targetPersonId) {
        throw new ValidationError(
          'MANAGER_CLAIM requires targetMembershipId and targetBuildingId only.',
        );
      }
      if (kase.targetBuildingId !== params.targetBuildingId) {
        throw new ValidationError('The enforcement target must match the confirmed fraud case.');
      }
    }
  }

  /** 07.03 Rule 019 — the target Person appeals an enforcement action. */
  async appealEnforcement(
    actionId: string,
    callerPersonId: string,
    reason: string | undefined,
    requestId: string,
  ) {
    const action = await this.backOffice.findEnforcementActionById(actionId);
    if (!action) throw new NotFoundAppError('Enforcement action not found.');

    const entitledAppellant = await this.backOffice.resolveEnforcementAppellant(action);
    this.policy.assertCanAppealEnforcement(action.appealStatus, entitledAppellant, callerPersonId);

    const updated = await this.backOffice.requestEnforcementAppeal(actionId, reason);

    await this.audit.record({
      actorId: callerPersonId,
      action: 'EnforcementActionAppealed',
      entityType: 'EnforcementAction',
      entityId: actionId,
      requestId,
      reason,
    });

    return updated;
  }

  /** 07.03 Rule 019 — staff decides a pending appeal. OVERTURN undoes the enforcement's system effect where one was applied. */
  async decideEnforcementAppeal(
    actionId: string,
    decision: 'UPHOLD' | 'OVERTURN',
    deciderPersonId: string,
    reason: string | undefined,
    requestId: string,
  ) {
    const action = await this.backOffice.findEnforcementActionById(actionId);
    if (!action) throw new NotFoundAppError('Enforcement action not found.');

    this.policy.assertAppealDecidable(action.appealStatus);

    const appealStatus = decision === 'UPHOLD' ? 'UPHELD' : 'OVERTURNED';
    const updated = await this.backOffice.decideEnforcementAppeal({
      id: actionId,
      appealStatus,
      appealDecidedById: deciderPersonId,
    });

    await this.audit.record({
      actorId: deciderPersonId,
      action: 'EnforcementActionAppealDecided',
      entityType: 'EnforcementAction',
      entityId: actionId,
      requestId,
      reason,
      metadata: { decision },
    });

    return updated;
  }

  /** 21_ADRs > ADR-050 — 07.03 Rule 020's staff-facing fraud metrics, see `BackOfficeRepository.getFraudCaseMetrics` for exactly what's computed and how. */
  getMetrics(fromDate?: Date, toDate?: Date) {
    return this.backOffice.getFraudCaseMetrics(fromDate, toDate);
  }
}
