import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { SupportCaseCategory, SupportCaseResolutionCode, VerificationPriority } from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { SupportCasePolicy } from '../domain/policies/support-case.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError, ValidationError } from '../../../common/errors/app-error';
import { SupportCaseResolvedEvent } from '../events/backoffice.events';

/**
 * Support & Operations Center (07.05_Support_And_Operations_Center_v1.0 —
 * see 21_ADRs > ADR-032). Covers Rules 001-012/015 and 017-018's
 * ticket/message/resolution/escalation/merge/reopen lifecycle; Rules 009
 * (SLA), 013 (parent/child), and 016 (Knowledge Base) remain explicitly out
 * of scope — see the schema section header comment. Rules 019-020
 * (metrics/dashboard) are now covered by `getMetrics` (21_ADRs > ADR-048).
 */
@Injectable()
export class SupportCaseService {
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly policy: SupportCasePolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  /** 07.05 Rule 001/002 — any authenticated Person may open a ticket. */
  async open(
    params: {
      category: SupportCaseCategory;
      subject: string;
      description: string;
      priority?: VerificationPriority;
      linkedEntityType?: string;
      linkedEntityId?: string;
    },
    createdById: string,
    requestId: string,
  ) {
    const kase = await this.backOffice.createSupportCase({
      category: params.category,
      priority: params.priority ?? 'NORMAL',
      subject: params.subject,
      description: params.description,
      createdById,
      linkedEntityType: params.linkedEntityType,
      linkedEntityId: params.linkedEntityId,
    });

    await this.audit.record({
      actorId: createdById,
      action: 'SupportCaseOpened',
      entityType: 'SupportCase',
      entityId: kase.id,
      requestId,
      metadata: { category: params.category },
    });

    return kase;
  }

  async getCase(caseId: string) {
    const kase = await this.backOffice.findSupportCaseById(caseId);
    if (!kase) throw new NotFoundAppError('Support case not found.');
    return kase;
  }

  /** Member-facing: 404s (via the policy, an AuthorizationError translated at the controller boundary like Marketplace's own non-staff visibility check) rather than exposing another Person's ticket. */
  async getCaseForOwner(caseId: string, callerPersonId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertVisibleToNonStaff(kase.createdById, callerPersonId);
    return kase;
  }

  listCases(filters: { status?: string; priority?: string; category?: string; assignedToId?: string }) {
    return this.backOffice.listSupportCases({
      status: filters.status as never,
      priority: filters.priority as never,
      category: filters.category as never,
      assignedToId: filters.assignedToId,
    });
  }

  listMine(createdById: string) {
    return this.backOffice.listSupportCasesForCreator(createdById);
  }

  /** 07.05 Rule 004 — assigning a ticket moves it from OPEN to IN_PROGRESS. */
  async assign(caseId: string, assigneeId: string, actorPersonId: string, requestId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertActionable(kase.status);

    const updated = await this.backOffice.assignSupportCase(caseId, assigneeId);

    await this.audit.record({
      actorId: actorPersonId,
      action: 'SupportCaseAssigned',
      entityType: 'SupportCase',
      entityId: caseId,
      requestId,
      metadata: { assigneeId },
    });

    return updated;
  }

  /** Staff-side message — may be internal (staff-only) or a reply visible to the ticket's creator. */
  async addStaffMessage(caseId: string, body: string, isInternal: boolean, senderId: string, requestId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertActionable(kase.status);

    const message = await this.backOffice.addSupportCaseMessage({ caseId, senderId, body, isInternal });

    if (kase.status === 'OPEN' && !isInternal) {
      await this.backOffice.updateSupportCaseStatus(caseId, 'WAITING_USER');
    }

    await this.audit.record({
      actorId: senderId,
      action: 'SupportCaseMessageAdded',
      entityType: 'SupportCase',
      entityId: caseId,
      requestId,
      metadata: { isInternal },
    });

    return message;
  }

  /** Member-facing reply — always visible (`isInternal: false`), regardless of what the client sends. */
  async replyAsCreator(caseId: string, body: string, callerPersonId: string, requestId: string) {
    const kase = await this.getCaseForOwner(caseId, callerPersonId);
    this.policy.assertActionable(kase.status);

    const message = await this.backOffice.addSupportCaseMessage({
      caseId,
      senderId: callerPersonId,
      body,
      isInternal: false,
    });

    if (kase.status === 'WAITING_USER') {
      await this.backOffice.updateSupportCaseStatus(caseId, 'IN_PROGRESS');
    }

    await this.audit.record({
      actorId: callerPersonId,
      action: 'SupportCaseMessageAdded',
      entityType: 'SupportCase',
      entityId: caseId,
      requestId,
    });

    return message;
  }

  /** 07.05 Rule 015 — resolving records a fixed-set resolution code. */
  async resolve(
    caseId: string,
    resolutionCode: SupportCaseResolutionCode,
    resolution: string | undefined,
    actorPersonId: string,
    requestId: string,
  ) {
    const kase = await this.getCase(caseId);
    this.policy.assertActionable(kase.status);

    const updated = await this.backOffice.resolveSupportCase({ id: caseId, resolutionCode, resolution });

    await this.audit.record({
      actorId: actorPersonId,
      action: 'SupportCaseResolved',
      entityType: 'SupportCase',
      entityId: caseId,
      requestId,
      metadata: { resolutionCode },
    });

    this.events.emit('SupportCaseResolved', new SupportCaseResolvedEvent(caseId, kase.createdById));

    return updated;
  }

  /** Only a RESOLVED ticket may be CLOSED — a distinct staff action from resolving it. */
  async close(caseId: string, actorPersonId: string, requestId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertResolvedForClose(kase.status);

    const updated = await this.backOffice.updateSupportCaseStatus(caseId, 'CLOSED');

    await this.audit.record({
      actorId: actorPersonId,
      action: 'SupportCaseClosed',
      entityType: 'SupportCase',
      entityId: caseId,
      requestId,
    });

    return updated;
  }

  /**
   * 07.05 Rule 011 — reopens the SAME ticket (status back to OPEN) rather
   * than creating a new linked case the way `BuildingVerificationCase`
   * appeals do — see ADR-032 Decision for why preserving the existing
   * message thread's continuity was chosen over the row-history-preserving
   * convention every prior BackOffice case type has used. Only the
   * `SupportReportController` (member-facing) exposes this today, so
   * ownership is checked here directly (`getCaseForOwner`, not `getCase`)
   * rather than at the controller layer.
   */
  async reopen(caseId: string, reason: string, actorPersonId: string, requestId: string) {
    const kase = await this.getCaseForOwner(caseId, actorPersonId);
    this.policy.assertCanReopen(kase.status);

    const updated = await this.backOffice.reopenSupportCase(caseId);
    await this.backOffice.addSupportCaseMessage({ caseId, senderId: actorPersonId, body: `Reopened: ${reason}`, isInternal: false });

    await this.audit.record({
      actorId: actorPersonId,
      action: 'SupportCaseReopened',
      entityType: 'SupportCase',
      entityId: caseId,
      requestId,
      reason,
    });

    return updated;
  }

  /** 07.05 Rule 008 — escalation raises priority by one level. */
  async escalate(caseId: string, actorPersonId: string, requestId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertActionable(kase.status);

    const nextPriority = this.policy.nextEscalatedPriority(kase.priority);
    const updated = await this.backOffice.escalateSupportCasePriority(caseId, nextPriority);

    await this.audit.record({
      actorId: actorPersonId,
      action: 'SupportCaseEscalated',
      entityType: 'SupportCase',
      entityId: caseId,
      requestId,
      metadata: { from: kase.priority, to: nextPriority },
    });

    return updated;
  }

  /** 07.05 Rule 012 — merges this case into another, closing this one. */
  async merge(caseId: string, intoCaseId: string, actorPersonId: string, requestId: string) {
    if (caseId === intoCaseId) {
      throw new ValidationError('A support case cannot be merged into itself.');
    }
    const kase = await this.getCase(caseId);
    this.policy.assertActionable(kase.status);
    await this.getCase(intoCaseId); // 404s if the target doesn't exist

    const updated = await this.backOffice.mergeSupportCase(caseId, intoCaseId);

    await this.audit.record({
      actorId: actorPersonId,
      action: 'SupportCaseMerged',
      entityType: 'SupportCase',
      entityId: caseId,
      requestId,
      metadata: { intoCaseId },
    });

    return updated;
  }

  /** 21_ADRs > ADR-048 — 07.05 Rule 019/020's staff-facing metrics/dashboard, see `BackOfficeRepository.getSupportCaseMetrics` for exactly what's computed and how. */
  getMetrics(fromDate?: Date, toDate?: Date) {
    return this.backOffice.getSupportCaseMetrics(fromDate, toDate);
  }
}
