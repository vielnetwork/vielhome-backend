import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CasePriority, CaseStatus, CaseType, MembershipRole } from '@prisma/client';
import { CaseRepository } from '../infrastructure/repositories/case.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { CasePolicy } from '../domain/policies/case.policy';
import { CreateCaseDto } from './dto/create-case.dto';
import { UpdateCaseDto } from './dto/update-case.dto';
import { AssignCaseDto } from './dto/assign-case.dto';
import { AddMessageDto } from './dto/add-message.dto';
import { ResolveCaseDto } from './dto/resolve-case.dto';
import { ReopenCaseDto } from './dto/reopen-case.dto';
import { MergeCaseDto } from './dto/merge-case.dto';
import { AuditService } from '../../../common/audit/audit.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';
import { CaseAssignedEvent, CaseCreatedEvent, CaseStatusChangedEvent } from '../events/case.events';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';

/** 08.08 Rule 008: cases are assignable to Manager/Board Member/Accountant — the same set gets privileged read/edit/internal-note access throughout this service. */
const PRIVILEGED_ROLES: MembershipRole[] = ['MANAGER', 'BOARD_MEMBER', 'ACCOUNTANT'];

@Injectable()
export class CasesService {
  constructor(
    private readonly cases: CaseRepository,
    private readonly buildings: BuildingRepository,
    private readonly policy: CasePolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private async getBuilding(buildingId: string) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
    return building;
  }

  private async isPrivileged(personId: string, buildingId: string): Promise<boolean> {
    const roles = await this.buildings.getRoles(personId, buildingId);
    return roles.some((role) => PRIVILEGED_ROLES.includes(role));
  }

  private async getCaseOrThrow(buildingId: string, caseId: string) {
    const found = await this.cases.findCaseById(caseId);
    if (!found || found.buildingId !== buildingId) {
      throw new NotFoundAppError('Case not found.');
    }
    return found;
  }

  async createCase(
    buildingId: string,
    dto: CreateCaseDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getBuilding(buildingId);

    if (dto.unitId) {
      const unit = await this.buildings.findUnitById(dto.unitId);
      if (!unit || unit.buildingId !== buildingId) {
        throw new NotFoundAppError('Unit not found.');
      }
    }

    const created = await this.cases.createCase({
      buildingId,
      unitId: dto.unitId,
      type: dto.type,
      title: dto.title,
      description: dto.description,
      priority: dto.priority ?? 'NORMAL',
      visibility: dto.visibility ?? 'PRIVATE',
      isAgainstManager: dto.isAgainstManager ?? false,
      createdById: actorPersonId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'CaseCreated',
      entityType: 'Case',
      entityId: created.id,
      requestId,
      metadata: { type: dto.type, priority: created.priority },
    });

    this.events.emit('CaseCreated', new CaseCreatedEvent(created.id, buildingId, actorPersonId));

    return created;
  }

  /**
   * 06.07 Rule 021: results are filtered per-caller — a non-privileged
   * caller only sees PUBLIC cases plus their own (created or assigned to
   * them), never every PRIVATE case in the building.
   */
  async listCases(
    buildingId: string,
    actorPersonId: string,
    filter?: { type?: CaseType; status?: CaseStatus; priority?: CasePriority; assigneeId?: string },
    pagination: PaginationParams = { page: 1, limit: 20 },
  ) {
    const privileged = await this.isPrivileged(actorPersonId, buildingId);
    const { items, total } = await this.cases.listCases(
      buildingId,
      filter,
      { actorPersonId, privileged },
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async getCase(buildingId: string, caseId: string, actorPersonId: string) {
    const found = await this.getCaseOrThrow(buildingId, caseId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);
    this.policy.assertVisible(found, actorPersonId, privileged);
    return found;
  }

  async updateCase(
    buildingId: string,
    caseId: string,
    dto: UpdateCaseDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const found = await this.getCaseOrThrow(buildingId, caseId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);
    this.policy.assertEditable(found.createdById, actorPersonId, privileged, found.status);

    const updated = await this.cases.updateCaseFields(caseId, dto);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'CaseUpdated',
      entityType: 'Case',
      entityId: caseId,
      requestId,
    });

    return updated;
  }

  async assignCase(
    buildingId: string,
    caseId: string,
    dto: AssignCaseDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const found = await this.getCaseOrThrow(buildingId, caseId);
    this.policy.assertAssignableStatus(found.status);

    const assigneeRoles = await this.buildings.getRoles(dto.assignedToId, buildingId);
    if (!assigneeRoles.some((role) => PRIVILEGED_ROLES.includes(role))) {
      throw new BusinessRuleViolationError(
        'The assignee must be a current Manager, Board Member, or Accountant of this building.',
      );
    }
    this.policy.assertAssignable(found.isAgainstManager, assigneeRoles.includes('MANAGER'));

    const { case: updated, assignment } = await this.cases.assignCase({
      caseId,
      assignedToId: dto.assignedToId,
      assignedById: actorPersonId,
      note: dto.note,
      expectedStatus: found.status,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'CaseAssigned',
      entityType: 'Case',
      entityId: caseId,
      requestId,
      metadata: { assignedToId: dto.assignedToId },
    });

    this.events.emit('CaseAssigned', new CaseAssignedEvent(caseId, buildingId, dto.assignedToId));

    return { case: updated, assignment };
  }

  async listAssignments(
    buildingId: string,
    caseId: string,
    actorPersonId: string,
    pagination: PaginationParams,
  ) {
    await this.getCase(buildingId, caseId, actorPersonId);
    const { items, total } = await this.cases.listAssignments(caseId, toSkipTake(pagination));
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async addMessage(
    buildingId: string,
    caseId: string,
    dto: AddMessageDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const found = await this.getCaseOrThrow(buildingId, caseId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);
    this.policy.assertVisible(found, actorPersonId, privileged);
    this.policy.assertCanPostInternalMessage(dto.isInternal ?? false, privileged);
    this.policy.assertMessageable(found.status);

    const message = await this.cases.createMessage({
      caseId,
      senderId: actorPersonId,
      message: dto.message,
      isInternal: dto.isInternal ?? false,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'CaseMessageAdded',
      entityType: 'Case',
      entityId: caseId,
      requestId,
      metadata: { isInternal: message.isInternal },
    });

    return message;
  }

  /** Internal notes (06.07 Rule 016) are stripped out for a non-privileged reader — never returned, not even as a redacted placeholder. */
  async listMessages(
    buildingId: string,
    caseId: string,
    actorPersonId: string,
    pagination: PaginationParams,
  ) {
    const found = await this.getCaseOrThrow(buildingId, caseId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);
    this.policy.assertVisible(found, actorPersonId, privileged);

    const { items, total } = await this.cases.listMessages(
      caseId,
      privileged,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async resolveCase(
    buildingId: string,
    caseId: string,
    dto: ResolveCaseDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const found = await this.getCaseOrThrow(buildingId, caseId);
    this.policy.assertResolvable(found.status);

    const updated = await this.cases.resolveCase(caseId, found.status, dto.resolutionCode);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'CaseResolved',
      entityType: 'Case',
      entityId: caseId,
      requestId,
      metadata: { resolutionCode: dto.resolutionCode },
    });

    this.events.emit(
      'CaseStatusChanged',
      new CaseStatusChangedEvent(caseId, buildingId, found.status, 'RESOLVED', actorPersonId),
    );

    return updated;
  }

  async closeCase(buildingId: string, caseId: string, actorPersonId: string, requestId: string) {
    const found = await this.getCaseOrThrow(buildingId, caseId);
    this.policy.assertCloseable(found.status);

    const updated = await this.cases.closeCase(caseId);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'CaseClosed',
      entityType: 'Case',
      entityId: caseId,
      requestId,
    });

    this.events.emit(
      'CaseStatusChanged',
      new CaseStatusChangedEvent(caseId, buildingId, found.status, 'CLOSED', actorPersonId),
    );

    return updated;
  }

  async reopenCase(
    buildingId: string,
    caseId: string,
    dto: ReopenCaseDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const found = await this.getCaseOrThrow(buildingId, caseId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);
    if (found.createdById !== actorPersonId && !privileged) {
      throw new AuthorizationError(
        'Only the case creator or a privileged role may reopen this case.',
      );
    }
    this.policy.assertReopenable(found.status);
    if (found.mergedIntoId) {
      throw new BusinessRuleViolationError('A merged case cannot be reopened.');
    }

    const updated = await this.cases.reopenCase(caseId, found.status);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'CaseReopened',
      entityType: 'Case',
      entityId: caseId,
      requestId,
      reason: dto.reason,
    });

    this.events.emit(
      'CaseStatusChanged',
      new CaseStatusChangedEvent(caseId, buildingId, found.status, 'OPEN', actorPersonId),
    );

    return updated;
  }

  /**
   * 08.08 Rule 016 — merges this case into another (the "same issue" case),
   * closing this one. Gated at the controller to the same
   * MANAGER/BOARD_MEMBER/ACCOUNTANT set as assign/resolve/close (08.08 Rule
   * 008) — the source names no distinct merge actor. `getCaseOrThrow` on
   * both ids doubles as the same-building restriction (a case can only be
   * merged into another case of the same building) — no source guidance
   * either way, the conservative default every other Cases action already
   * follows implicitly.
   */
  async mergeCase(
    buildingId: string,
    caseId: string,
    dto: MergeCaseDto,
    actorPersonId: string,
    requestId: string,
  ) {
    if (caseId === dto.intoCaseId) {
      throw new ValidationError('A case cannot be merged into itself.');
    }
    const found = await this.getCaseOrThrow(buildingId, caseId);
    if (found.mergedIntoId)
      throw new ValidationError('Cannot merge a case that is already merged.');
    this.policy.assertNotClosed(found.status);
    const target = await this.getCaseOrThrow(buildingId, dto.intoCaseId);
    if (target.mergedIntoId === caseId)
      throw new ValidationError('This merge would create a cycle.');
    if (target.mergedIntoId)
      throw new ValidationError('Cannot merge into a case that is already merged.');
    if (target.status === 'RESOLVED' || target.status === 'CLOSED') {
      throw new ValidationError('Cannot merge into a terminal case.');
    }

    const updated = await this.cases.mergeCase(caseId, dto.intoCaseId, found.status);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'CaseMerged',
      entityType: 'Case',
      entityId: caseId,
      requestId,
      metadata: { intoCaseId: dto.intoCaseId },
    });

    this.events.emit(
      'CaseStatusChanged',
      new CaseStatusChangedEvent(caseId, buildingId, found.status, 'CLOSED', actorPersonId),
    );

    return updated;
  }
}
