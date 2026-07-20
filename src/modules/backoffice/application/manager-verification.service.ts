import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ManagerVerificationDecision, VerificationPriority } from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { ManagerVerificationPolicy } from '../domain/policies/manager-verification.policy';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { DuplicateError, NotFoundAppError } from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';
import { ManagerVerificationDecidedEvent } from '../events/backoffice.events';

const REQUIRED_APPROVAL_PERCENT = 30; // 06.03 Rule 002

/**
 * Manager Verification Queue (07.02 / 06.03_Manager_Verification_Flow —
 * see 21_ADRs > ADR-029). Two parallel paths reach the same terminal
 * states: accumulating Owner Approval (`approveByOwner`) and staff Admin
 * Review (`decideCase`). ELECTED / APPOINTED / BACKOFFICE_ASSIGNED manager
 * assignments never reach this service at all — `BuildingRepository
 * .changeManager` already marks those `VERIFIED` immediately (see ADR-029
 * Decision point 4) — only a PROVISIONAL self-claim goes through a case.
 *
 * `restoreManagement` (21_ADRs > ADR-040) is a third, later-added path:
 * unlike Owner Approval/Admin Review, which both move a case FROM PENDING,
 * Restore moves a SUSPENDED manager back to VERIFIED — 07_BackOffice_v2.0's
 * own fourth named staff action ("Approve, Reject, Suspend, Restore"),
 * missing from this codebase until now.
 */
@Injectable()
export class ManagerVerificationService {
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly policy: ManagerVerificationPolicy,
    private readonly buildings: BuildingRepository,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Called by `BackOfficeEventListener` right after a building is created
   * with a PROVISIONAL manager membership (`BuildingCreatedEvent.role ===
   * 'MANAGER'`). 06.03 Rule 001: a fresh PROVISIONAL claim always starts
   * as an open case awaiting Owner Approval — the Admin Review path is
   * reached only if/when a platform reviewer decides it directly, not as
   * a separate initiation step.
   */
  async initiateForProvisionalManager(params: {
    buildingId: string;
    membershipId: string;
    candidateId: string;
    isReverification?: boolean;
  }) {
    const priority: VerificationPriority = params.isReverification ? 'HIGH' : 'NORMAL';
    const kase = await this.backOffice.createManagerVerificationCase({
      buildingId: params.buildingId,
      membershipId: params.membershipId,
      candidateId: params.candidateId,
      priority,
      isReverification: params.isReverification,
    });

    await this.audit.record({
      buildingId: params.buildingId,
      action: 'ManagerVerificationQueued',
      entityType: 'ManagerVerificationCase',
      entityId: kase.id,
      metadata: { candidateId: params.candidateId, isReverification: !!params.isReverification },
    });

    return kase;
  }

  async getCase(caseId: string) {
    const kase = await this.backOffice.findManagerVerificationCaseById(caseId);
    if (!kase) throw new NotFoundAppError('Manager verification case not found.');
    return kase;
  }

  /** 21_ADRs > ADR-072 — uses `...CasesPaged`, not the unpaginated `listManagerVerificationCases` `appealCase` below still relies on for its own internal full-scan lookup. */
  async listCases(filters: { status?: string; priority?: string }, pagination: PaginationParams) {
    const { items, total } = await this.backOffice.listManagerVerificationCasesPaged(
      {
        status: filters.status as never,
        priority: filters.priority as never,
      },
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  /**
   * 06.03 Rule 002 — an owner votes to approve the current PROVISIONAL
   * manager. Once the accumulated approvals cross `requiredApprovalPercent`
   * of current owners, the case resolves to VERIFIED with source
   * OWNER_APPROVAL, the membership is verified, and the building leaves
   * Recovery Mode (if it was in it).
   */
  async approveByOwner(buildingId: string, callerPersonId: string, requestId: string) {
    const kase = await this.backOffice.getOpenManagerVerificationCaseForBuilding(buildingId);
    if (!kase) throw new NotFoundAppError('No open manager verification case for this building.');

    this.policy.assertCaseOpen(kase.status);
    this.policy.assertNotSelfApproving(kase.candidateId, callerPersonId);

    const existing = await this.backOffice.findManagerVerificationApproval(kase.id, callerPersonId);
    if (existing) throw new DuplicateError('You have already approved this manager verification.');

    await this.backOffice.createManagerVerificationApproval(kase.id, callerPersonId);

    const [approverCount, totalOwners] = await Promise.all([
      this.backOffice.countManagerVerificationApprovals(kase.id),
      this.buildings.countCurrentOwners(buildingId),
    ]);

    await this.audit.record({
      actorId: callerPersonId,
      buildingId,
      action: 'ManagerVerificationApprovalCast',
      entityType: 'ManagerVerificationCase',
      entityId: kase.id,
      requestId,
      metadata: { approverCount, totalOwners },
    });

    if (
      !this.policy.meetsApprovalThreshold(
        approverCount,
        totalOwners,
        kase.requiredApprovalPercent ?? REQUIRED_APPROVAL_PERCENT,
      )
    ) {
      return { case: kase, resolved: false, approverCount, totalOwners };
    }

    const updated = await this.backOffice.decideManagerVerificationCase({
      id: kase.id,
      status: 'VERIFIED',
      decision: 'APPROVE',
      verificationSource: 'OWNER_APPROVAL',
      reason: `Approved by ${approverCount}/${totalOwners} current owners (>= ${kase.requiredApprovalPercent ?? REQUIRED_APPROVAL_PERCENT}% required).`,
    });

    await this.buildings.verifyManagerMembership(kase.membershipId);
    await this.buildings.setRecoveryMode(buildingId, false);

    await this.audit.record({
      buildingId,
      action: 'ManagerVerificationDecided',
      entityType: 'ManagerVerificationCase',
      entityId: kase.id,
      requestId,
      metadata: { verificationSource: 'OWNER_APPROVAL', approverCount, totalOwners },
    });

    this.events.emit(
      'ManagerVerificationDecided',
      new ManagerVerificationDecidedEvent(buildingId, kase.id, 'VERIFIED', kase.candidateId),
    );

    return { case: updated, resolved: true, approverCount, totalOwners };
  }

  /**
   * Platform staff Admin Review path (07.02 Rule 003-008). APPROVE and
   * REJECT mirror the Owner Approval / rejection terminal states; SUSPEND
   * is a distinct terminal state (07.02 Rule 010) that keeps the
   * membership current but blocks governance features (06.03 Rule 006)
   * until reverified.
   */
  async decideCase(
    caseId: string,
    decision: ManagerVerificationDecision,
    reviewerPersonId: string,
    reason: string | undefined,
    requestId: string,
  ) {
    const kase = await this.getCase(caseId);
    this.policy.assertCaseOpen(kase.status);

    const status =
      decision === 'APPROVE' ? 'VERIFIED' : decision === 'REJECT' ? 'REJECTED' : 'SUSPENDED';

    const updated = await this.backOffice.decideManagerVerificationCase({
      id: caseId,
      status,
      decision,
      verificationSource: decision === 'APPROVE' ? 'ADMIN_REVIEW' : undefined,
      reviewedById: reviewerPersonId,
      reason,
    });

    if (decision === 'APPROVE') {
      await this.buildings.verifyManagerMembership(kase.membershipId);
      await this.buildings.setRecoveryMode(kase.buildingId, false);
    } else if (decision === 'REJECT') {
      await this.buildings.endManagement(kase.membershipId);
      await this.buildings.setRecoveryMode(kase.buildingId, true);
    } else {
      await this.buildings.suspendManagement(kase.membershipId);
      await this.buildings.setRecoveryMode(kase.buildingId, true);
    }

    await this.audit.record({
      actorId: reviewerPersonId,
      buildingId: kase.buildingId,
      action: 'ManagerVerificationDecided',
      entityType: 'ManagerVerificationCase',
      entityId: caseId,
      requestId,
      reason,
      metadata: { decision },
    });

    this.events.emit(
      'ManagerVerificationDecided',
      new ManagerVerificationDecidedEvent(kase.buildingId, caseId, status, kase.candidateId),
    );

    return updated;
  }

  /**
   * 21_ADRs > ADR-040 — the "Restore" action `07_BackOffice_v2.0` names
   * alongside Approve/Reject/Suspend but that this codebase never built
   * (surfaced as a disclosed gap while building ADR-038's
   * `VerifiedRolesGuard`: a SUSPENDED manager had no route back to
   * VERIFIED at all). Deliberately does NOT reuse `decideCase`'s "update
   * the existing case" shape — mutating an already-decided (SUSPENDED)
   * case in place would be the first time this codebase edits a terminal
   * case row rather than preserving it, breaking the "case history via
   * fresh linked rows, never edit a decided case" convention every other
   * case type here follows (Building Verification's appeal chain, this
   * same service's own `appealCase`). Instead, this creates a NEW case
   * (marked `isReverification: true`, same as `appealCase`) already
   * decided as VERIFIED via `decision: RESTORE` — the SUSPENDED case stays
   * exactly as it was, a permanent record that the suspension happened,
   * with the restore now a separate, equally permanent record alongside
   * it. A direct platform-staff decision (`SENIOR_REVIEWER`+, same actor
   * set as `decide`), not a self-service action — no caller-identity
   * check, unlike `appealCase`.
   */
  async restoreManagement(
    caseId: string,
    reviewerPersonId: string,
    reason: string | undefined,
    requestId: string,
  ) {
    const suspended = await this.getCase(caseId);
    this.policy.assertCanRestore(suspended.status);

    const restoreCase = await this.backOffice.createManagerVerificationCase({
      buildingId: suspended.buildingId,
      membershipId: suspended.membershipId,
      candidateId: suspended.candidateId,
      priority: 'NORMAL',
      isReverification: true,
    });

    const decided = await this.backOffice.decideManagerVerificationCase({
      id: restoreCase.id,
      status: 'VERIFIED',
      decision: 'RESTORE',
      verificationSource: 'ADMIN_REVIEW',
      reviewedById: reviewerPersonId,
      reason,
    });

    await this.buildings.verifyManagerMembership(suspended.membershipId);
    await this.buildings.setRecoveryMode(suspended.buildingId, false);

    await this.audit.record({
      actorId: reviewerPersonId,
      buildingId: suspended.buildingId,
      action: 'ManagerVerificationRestored',
      entityType: 'ManagerVerificationCase',
      entityId: restoreCase.id,
      requestId,
      reason,
      metadata: { suspendedCaseId: suspended.id },
    });

    this.events.emit(
      'ManagerVerificationDecided',
      new ManagerVerificationDecidedEvent(
        suspended.buildingId,
        restoreCase.id,
        'VERIFIED',
        suspended.candidateId,
      ),
    );

    return decided;
  }

  /** 07.02 Rule 012/013 — only the rejected candidate may appeal; opens a fresh case marked as a reverification. */
  async appealCase(buildingId: string, callerPersonId: string, requestId: string) {
    const cases = await this.backOffice.listManagerVerificationCases({});
    const latest = cases
      .filter((c) => c.buildingId === buildingId && c.candidateId === callerPersonId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!latest) throw new NotFoundAppError('No verification case found for this candidate.');

    this.policy.assertCanAppeal(latest.status, callerPersonId, latest.candidateId);

    const appeal = await this.backOffice.createManagerVerificationCase({
      buildingId,
      membershipId: latest.membershipId,
      candidateId: callerPersonId,
      priority: 'HIGH',
      isReverification: true,
    });

    await this.audit.record({
      actorId: callerPersonId,
      buildingId,
      action: 'ManagerVerificationAppealed',
      entityType: 'ManagerVerificationCase',
      entityId: appeal.id,
      requestId,
      metadata: { previousCaseId: latest.id },
    });

    return appeal;
  }
}
