import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  EnforcementActionType,
  EnforcementTargetType,
  FraudSignalType,
  VerificationPriority,
} from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { FraudCasePolicy } from '../domain/policies/fraud-case.policy';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { AuditService } from '../../../common/audit/audit.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';
import { EnforcementActionIssuedEvent, FraudCaseDecidedEvent } from '../events/backoffice.events';

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
    private readonly buildings: BuildingRepository,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
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

  listCases(filters: { status?: string; priority?: string; assignedToId?: string }) {
    return this.backOffice.listFraudCases({
      status: filters.status as never,
      priority: filters.priority as never,
      assignedToId: filters.assignedToId,
    });
  }

  /** 07.03 Rule 017 (staff queue) — assigning an investigator moves the case from OPEN to UNDER_INVESTIGATION. */
  async assignCase(caseId: string, assigneeId: string, actorPersonId: string, requestId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertInvestigable(kase.status);

    const updated = await this.backOffice.assignFraudCase(caseId, assigneeId);

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

    const updated = await this.backOffice.addFraudCaseEvidence(caseId, evidenceNotes);

    await this.audit.record({
      actorId: actorPersonId,
      action: 'FraudCaseEvidenceAdded',
      entityType: 'FraudCase',
      entityId: caseId,
      requestId,
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
    this.assertTargetMatchesType(params);

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

    const action = await this.backOffice.createEnforcementAction({
      fraudCaseId: caseId,
      type: params.type,
      targetType: params.targetType,
      targetPersonId: params.targetPersonId,
      targetBuildingId: params.targetBuildingId,
      targetMembershipId: params.targetMembershipId,
      reason: params.reason,
      issuedById,
    });

    await this.applyEnforcementEffect(params);

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

  private assertTargetMatchesType(params: {
    targetType: EnforcementTargetType;
    targetPersonId?: string;
    targetBuildingId?: string;
    targetMembershipId?: string;
  }): void {
    if (params.targetType === 'PERSON' && !params.targetPersonId) {
      throw new ValidationError('targetPersonId is required when targetType is PERSON.');
    }
    if (params.targetType === 'BUILDING' && !params.targetBuildingId) {
      throw new ValidationError('targetBuildingId is required when targetType is BUILDING.');
    }
    if (
      params.targetType === 'MANAGER_CLAIM' &&
      (!params.targetMembershipId || !params.targetBuildingId)
    ) {
      throw new ValidationError(
        'targetMembershipId and targetBuildingId are both required when targetType is MANAGER_CLAIM.',
      );
    }
  }

  private async applyEnforcementEffect(params: {
    type: EnforcementActionType;
    targetType: EnforcementTargetType;
    targetPersonId?: string;
    targetBuildingId?: string;
    targetMembershipId?: string;
  }): Promise<void> {
    if (
      params.type === 'ACCOUNT_SUSPENSION' &&
      params.targetType === 'PERSON' &&
      params.targetPersonId
    ) {
      await this.backOffice.suspendPerson(params.targetPersonId);
      return;
    }
    if (
      params.type === 'VERIFICATION_REVOCATION' &&
      params.targetType === 'BUILDING' &&
      params.targetBuildingId
    ) {
      await this.buildings.updateBuildingStatus(params.targetBuildingId, 'REJECTED');
      return;
    }
    if (
      params.type === 'VERIFICATION_REVOCATION' &&
      params.targetType === 'MANAGER_CLAIM' &&
      params.targetMembershipId &&
      params.targetBuildingId
    ) {
      await this.buildings.suspendManagement(params.targetMembershipId);
      await this.buildings.setRecoveryMode(params.targetBuildingId, true);
      return;
    }
    // WARNING / TEMPORARY_RESTRICTION: recorded only, no system-enforced effect this sprint.
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

    this.policy.assertCanAppealEnforcement(
      action.appealStatus,
      action.targetPersonId,
      callerPersonId,
    );

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

    if (decision === 'OVERTURN') {
      await this.reverseEnforcementEffect(action);
    }

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

  private async reverseEnforcementEffect(action: {
    type: EnforcementActionType;
    targetType: EnforcementTargetType;
    targetPersonId: string | null;
    targetBuildingId: string | null;
    targetMembershipId: string | null;
  }): Promise<void> {
    if (action.type === 'ACCOUNT_SUSPENSION' && action.targetPersonId) {
      await this.backOffice.reinstatePerson(action.targetPersonId);
      return;
    }
    if (
      action.type === 'VERIFICATION_REVOCATION' &&
      action.targetType === 'BUILDING' &&
      action.targetBuildingId
    ) {
      await this.buildings.updateBuildingStatus(action.targetBuildingId, 'VERIFIED');
      return;
    }
    if (
      action.type === 'VERIFICATION_REVOCATION' &&
      action.targetType === 'MANAGER_CLAIM' &&
      action.targetMembershipId &&
      action.targetBuildingId
    ) {
      await this.buildings.verifyManagerMembership(action.targetMembershipId);
      await this.buildings.setRecoveryMode(action.targetBuildingId, false);
      return;
    }
    // WARNING / TEMPORARY_RESTRICTION: nothing was system-enforced, nothing to reverse.
  }

  /** 21_ADRs > ADR-050 — 07.03 Rule 020's staff-facing fraud metrics, see `BackOfficeRepository.getFraudCaseMetrics` for exactly what's computed and how. */
  getMetrics(fromDate?: Date, toDate?: Date) {
    return this.backOffice.getFraudCaseMetrics(fromDate, toDate);
  }
}
