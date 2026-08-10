import { Injectable } from '@nestjs/common';
import type { ComplianceCaseCategory, FraudCaseStatus, VerificationPriority } from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { ComplianceCasePolicy } from '../domain/policies/compliance-case.policy';
import { AuditService } from '../../../common/audit/audit.service';
import {
  BusinessRuleViolationError,
  ConflictError,
  NotFoundAppError,
} from '../../../common/errors/app-error';
import { PermissionResolverService } from '../../backoffice-rbac/application/permission-resolver.service';
import type { EligibleComplianceAssigneeDto } from './dto/eligible-compliance-assignee.dto';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';

// 07.06 Rule 011's examples ("Repeated Fraud," "Repeated Suspensions,"
// "Financial Anomalies") without stating numeric thresholds — these are
// this ADR's own reasoned choice, disclosed as a single honest heuristic
// per category, not a full signal set (same discipline already applied
// to Building Verification's risk score and Fraud & Abuse's Rule 001).
const REPEATED_FRAUD_THRESHOLD = 3;
const REPEATED_SUSPENSION_THRESHOLD = 2;
const FINANCIAL_ANOMALY_THRESHOLD = 3;

/**
 * Compliance Cases (07.06_Audit_And_Compliance_Center_v1.0 Rules 011/012
 * — see 21_ADRs > ADR-034). Covers both the manual "staff opens a case"
 * path and `detectAnomalies`, a staff-triggered stand-in for a not-yet-
 * built scheduler (the same recurring gap ADR-024/025/026/028/029/031/
 * 032/033 have each already flagged, now flagged a ninth time).
 */
@Injectable()
export class ComplianceCaseService {
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly policy: ComplianceCasePolicy,
    private readonly audit: AuditService,
    private readonly permissions: PermissionResolverService,
  ) {}

  async open(
    params: {
      category: ComplianceCaseCategory;
      subjectActorId?: string;
      linkedEntityType?: string;
      linkedEntityId?: string;
      sourceAuditLogIds?: string[];
      description: string;
      priority?: VerificationPriority;
    },
    staffPersonId: string,
    requestId: string,
  ) {
    const kase = await this.backOffice.createComplianceCase({
      category: params.category,
      priority: params.priority,
      subjectActorId: params.subjectActorId,
      linkedEntityType: params.linkedEntityType,
      linkedEntityId: params.linkedEntityId,
      sourceAuditLogIds: params.sourceAuditLogIds,
      description: params.description,
      openedById: staffPersonId,
    });

    await this.audit.record({
      actorId: staffPersonId,
      action: 'ComplianceCaseOpened',
      entityType: 'ComplianceCase',
      entityId: kase.id,
      requestId,
      metadata: { category: params.category },
    });

    return kase;
  }

  async getCase(caseId: string) {
    const kase = await this.backOffice.findComplianceCaseById(caseId);
    if (!kase) throw new NotFoundAppError('Compliance case not found.');
    return kase;
  }

  /** 21_ADRs > ADR-072 */
  async listCases(
    filters: {
      status?: FraudCaseStatus;
      category?: ComplianceCaseCategory;
      priority?: VerificationPriority;
      assignedToId?: string;
      subjectActorId?: string;
    },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.backOffice.listComplianceCases(
      {
        status: filters.status,
        category: filters.category,
        priority: filters.priority,
        assignedToId: filters.assignedToId,
        subjectActorId: filters.subjectActorId,
      },
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async assign(caseId: string, assignedToId: string, actorPersonId: string, requestId: string) {
    const kase = await this.getCase(caseId);
    this.policy.assertInvestigable(kase.status);
    if (kase.status === 'UNDER_INVESTIGATION' && kase.assignedToId === assignedToId) {
      throw new ConflictError('Compliance case is already assigned to this staff member.');
    }
    await this.requireEligibleAssignee(assignedToId);

    const updated = await this.backOffice.assignComplianceCase(
      caseId,
      assignedToId,
      kase.status,
      kase.assignedToId,
    );

    await this.audit.record({
      actorId: actorPersonId,
      action: 'ComplianceCaseAssigned',
      entityType: 'ComplianceCase',
      entityId: caseId,
      requestId,
      metadata: { assignedToId },
    });

    return updated;
  }

  async listEligibleAssignees(): Promise<EligibleComplianceAssigneeDto[]> {
    const candidates = await this.backOffice.listComplianceAssigneeCandidateIds();
    const resolved = await Promise.all(
      candidates.map(({ personId }) => this.resolveEligibleAssignee(personId)),
    );
    return resolved
      .filter((candidate): candidate is EligibleComplianceAssigneeDto => candidate !== null)
      .sort((left, right) =>
        (left.displayName ?? left.id).localeCompare(right.displayName ?? right.id),
      );
  }

  private async requireEligibleAssignee(personId: string): Promise<EligibleComplianceAssigneeDto> {
    const staff = await this.backOffice.findComplianceAssigneeCandidate(personId);
    if (!staff) throw new NotFoundAppError('Compliance assignee not found.');

    const eligible = await this.resolveEligibleAssignee(personId, staff);
    if (!eligible) {
      throw new BusinessRuleViolationError('Assignee is not eligible for Compliance assignment.');
    }
    return eligible;
  }

  private async resolveEligibleAssignee(
    personId: string,
    candidate?: Awaited<ReturnType<BackOfficeRepository['findComplianceAssigneeCandidate']>>,
  ): Promise<EligibleComplianceAssigneeDto | null> {
    const staff = candidate ?? (await this.backOffice.findComplianceAssigneeCandidate(personId));
    if (!staff || !staff.isActive || staff.person.isSuspended) return null;

    const granted = await this.permissions.resolve(personId);
    if (!granted.has('COMPLIANCE_MANAGE')) return null;

    const normalizedName = staff.person.fullName?.trim();
    return { id: staff.personId, displayName: normalizedName || null };
  }

  async decide(
    caseId: string,
    decision: 'CONFIRM' | 'DISMISS',
    deciderPersonId: string,
    reason: string | undefined,
    requestId: string,
  ) {
    const kase = await this.getCase(caseId);
    this.policy.assertInvestigable(kase.status);

    const status = decision === 'CONFIRM' ? 'CONFIRMED' : 'DISMISSED';
    const updated = await this.backOffice.decideComplianceCase({
      id: caseId,
      status,
      decidedById: deciderPersonId,
      decisionReason: reason,
      expectedStatus: kase.status,
      expectedAssignedToId: kase.assignedToId,
    });

    await this.audit.record({
      actorId: deciderPersonId,
      action: 'ComplianceCaseDecided',
      entityType: 'ComplianceCase',
      entityId: caseId,
      requestId,
      reason,
      metadata: { decision },
    });

    return updated;
  }

  /**
   * Runs the three heuristics below and auto-opens a `ComplianceCase` for
   * any pattern not already covered by an open case for the same subject.
   * Staff-triggered or scheduler-triggered (21_ADRs > ADR-036 wires this
   * to a daily repeatable job with `staffPersonId: undefined`) — mirrors
   * `SubscriptionService.evaluateExpiry`'s same optional-actor shape.
   */
  async detectAnomalies(staffPersonId: string | undefined, requestId: string) {
    const created: Awaited<ReturnType<BackOfficeRepository['createComplianceCase']>>[] = [];

    const fraudGroups =
      await this.backOffice.findPersonsWithRepeatedConfirmedFraud(REPEATED_FRAUD_THRESHOLD);
    for (const g of fraudGroups) {
      if (!g.targetPersonId) continue;
      const opened = await this.autoOpen(
        'REPEATED_FRAUD',
        g.targetPersonId,
        g._count.targetPersonId,
        staffPersonId,
        requestId,
        'CONFIRMED fraud cases',
      );
      if (opened) created.push(opened);
    }

    const suspensionGroups = await this.backOffice.findPersonsWithRepeatedSuspensions(
      REPEATED_SUSPENSION_THRESHOLD,
    );
    for (const g of suspensionGroups) {
      if (!g.targetPersonId) continue;
      const opened = await this.autoOpen(
        'REPEATED_SUSPENSION',
        g.targetPersonId,
        g._count.targetPersonId,
        staffPersonId,
        requestId,
        'ACCOUNT_SUSPENSION enforcement actions',
      );
      if (opened) created.push(opened);
    }

    const financialGroups = await this.backOffice.findActorsWithRepeatedRejectedPayments(
      FINANCIAL_ANOMALY_THRESHOLD,
    );
    for (const g of financialGroups) {
      if (!g.actorId) continue;
      const opened = await this.autoOpen(
        'FINANCIAL_ANOMALY',
        g.actorId,
        g._count.actorId,
        staffPersonId,
        requestId,
        'rejected-payment audit events',
      );
      if (opened) created.push(opened);
    }

    return created;
  }

  private async autoOpen(
    category: ComplianceCaseCategory,
    subjectActorId: string,
    count: number,
    staffPersonId: string | undefined,
    requestId: string,
    describedAs: string,
  ) {
    const kase = await this.backOffice.createAutoDetectedComplianceCase({
      category,
      subjectActorId,
      description: `Auto-detected: ${count} ${describedAs} for this actor.`,
    });
    if (!kase) return null;

    await this.audit.record({
      actorId: staffPersonId,
      action: 'ComplianceCaseAutoOpened',
      entityType: 'ComplianceCase',
      entityId: kase.id,
      requestId,
      metadata: { category, subjectActorId, count },
    });

    return kase;
  }
}
