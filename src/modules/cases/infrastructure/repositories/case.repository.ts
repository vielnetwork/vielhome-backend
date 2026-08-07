import { Injectable } from '@nestjs/common';
import {
  CasePriority,
  CaseResolutionCode,
  CaseStatus,
  CaseType,
  CaseVisibility,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ConflictError } from '../../../../common/errors/app-error';

@Injectable()
export class CaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  createCase(params: {
    buildingId: string;
    unitId?: string;
    type: CaseType;
    title: string;
    description: string;
    priority: CasePriority;
    visibility: CaseVisibility;
    isAgainstManager: boolean;
    createdById: string;
  }) {
    return this.prisma.case.create({ data: params });
  }

  findCaseById(id: string) {
    return this.prisma.case.findUnique({ where: { id } });
  }

  async listCases(
    buildingId: string,
    filter: { type?: CaseType; status?: CaseStatus; priority?: CasePriority; assigneeId?: string } | undefined,
    access: { actorPersonId: string; privileged: boolean },
    pagination: { skip: number; take: number },
  ) {
    const where: Prisma.CaseWhereInput = {
      buildingId,
      ...(filter?.type ? { type: filter.type } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
      ...(filter?.priority ? { priority: filter.priority } : {}),
      ...(filter?.assigneeId ? { assigneeId: filter.assigneeId } : {}),
      ...(!access.privileged
        ? {
            OR: [
              { visibility: 'PUBLIC' },
              { createdById: access.actorPersonId },
              { assigneeId: access.actorPersonId },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.case.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pagination,
      }),
      this.prisma.case.count({ where }),
    ]);
    return { items, total };
  }

  updateCaseFields(
    id: string,
    data: {
      title?: string;
      description?: string;
      priority?: CasePriority;
      visibility?: CaseVisibility;
    },
  ) {
    return this.prisma.case.update({ where: { id }, data });
  }

  /**
   * Assigns a case and writes the append-only history row in one
   * transaction (06.07 Rule 005/011) — `Case.assigneeId` is a denormalized
   * "current assignee" pointer for fast reads; `CaseAssignment` rows are
   * the real history.
   */
  assignCase(params: {
    caseId: string;
    assignedToId: string;
    assignedById: string;
    note?: string;
    expectedStatus: CaseStatus;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.case.updateMany({
        where: { id: params.caseId, status: params.expectedStatus },
        data: { assigneeId: params.assignedToId, status: 'IN_PROGRESS' },
      });
      if (claimed.count !== 1) throw new ConflictError('Case status changed; reload and retry.');
      const updated = await tx.case.findUniqueOrThrow({ where: { id: params.caseId } });
      const assignment = await tx.caseAssignment.create({
        data: {
          caseId: params.caseId,
          assignedToId: params.assignedToId,
          assignedById: params.assignedById,
          note: params.note,
        },
      });
      return { case: updated, assignment };
    });
  }

  async listAssignments(caseId: string, pagination: { skip: number; take: number }) {
    const where = { caseId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.caseAssignment.findMany({
        where,
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        ...pagination,
      }),
      this.prisma.caseAssignment.count({ where }),
    ]);
    return { items, total };
  }

  createMessage(params: {
    caseId: string;
    senderId: string;
    message: string;
    isInternal: boolean;
  }) {
    return this.prisma.caseMessage.create({ data: params });
  }

  async listMessages(
    caseId: string,
    includeInternal: boolean,
    pagination: { skip: number; take: number },
  ) {
    const where: Prisma.CaseMessageWhereInput = {
      caseId,
      ...(!includeInternal ? { isInternal: false } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.caseMessage.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...pagination,
      }),
      this.prisma.caseMessage.count({ where }),
    ]);
    return { items, total };
  }

  async resolveCase(id: string, expectedStatus: CaseStatus, resolutionCode: CaseResolutionCode) {
    const result = await this.prisma.case.updateMany({
      where: { id, status: expectedStatus }, data: { status: 'RESOLVED', resolutionCode },
    });
    if (result.count !== 1) throw new ConflictError('Case status changed; reload and retry.');
    return this.prisma.case.findUniqueOrThrow({ where: { id } });
  }

  async closeCase(id: string) {
    const result = await this.prisma.case.updateMany({
      where: { id, status: 'RESOLVED' }, data: { status: 'CLOSED', closedAt: new Date() },
    });
    if (result.count !== 1) throw new ConflictError('Case is no longer resolved.');
    return this.prisma.case.findUniqueOrThrow({ where: { id } });
  }

  async reopenCase(id: string, expectedStatus: CaseStatus) {
    const result = await this.prisma.case.updateMany({
      where: { id, status: expectedStatus },
      data: { status: 'OPEN', closedAt: null, resolutionCode: null },
    });
    if (result.count !== 1) throw new ConflictError('Case status changed; reload and retry.');
    return this.prisma.case.findUniqueOrThrow({ where: { id } });
  }

  /** 08.08 Rule 016 — merges this case into another, closing this one. Mirrors `BackOfficeRepository.mergeSupportCase` (ADR-032). */
  async mergeCase(id: string, mergedIntoId: string, expectedStatus: CaseStatus) {
    const result = await this.prisma.case.updateMany({
      where: { id, status: expectedStatus, mergedIntoId: null },
      data: { mergedIntoId, status: 'CLOSED', closedAt: new Date() },
    });
    if (result.count !== 1) throw new ConflictError('Case status changed or was already merged.');
    return this.prisma.case.findUniqueOrThrow({ where: { id } });
  }
}
