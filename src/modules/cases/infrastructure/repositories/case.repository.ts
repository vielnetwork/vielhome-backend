import { Injectable } from '@nestjs/common';
import {
  CasePriority,
  CaseResolutionCode,
  CaseStatus,
  CaseType,
  CaseVisibility,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

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

  listCases(
    buildingId: string,
    filter?: { type?: CaseType; status?: CaseStatus; priority?: CasePriority; assigneeId?: string },
  ) {
    return this.prisma.case.findMany({
      where: {
        buildingId,
        ...(filter?.type ? { type: filter.type } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.priority ? { priority: filter.priority } : {}),
        ...(filter?.assigneeId ? { assigneeId: filter.assigneeId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
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
  }) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.case.update({
        where: { id: params.caseId },
        data: { assigneeId: params.assignedToId, status: 'IN_PROGRESS' },
      });
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

  listAssignments(caseId: string) {
    return this.prisma.caseAssignment.findMany({
      where: { caseId },
      orderBy: { assignedAt: 'desc' },
    });
  }

  createMessage(params: {
    caseId: string;
    senderId: string;
    message: string;
    isInternal: boolean;
  }) {
    return this.prisma.caseMessage.create({ data: params });
  }

  listMessages(caseId: string) {
    return this.prisma.caseMessage.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' } });
  }

  resolveCase(id: string, resolutionCode: CaseResolutionCode) {
    return this.prisma.case.update({
      where: { id },
      data: { status: 'RESOLVED', resolutionCode },
    });
  }

  closeCase(id: string) {
    return this.prisma.case.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  }

  reopenCase(id: string) {
    return this.prisma.case.update({
      where: { id },
      data: { status: 'OPEN', closedAt: null, resolutionCode: null },
    });
  }

  /** 08.08 Rule 016 — merges this case into another, closing this one. Mirrors `BackOfficeRepository.mergeSupportCase` (ADR-032). */
  mergeCase(id: string, mergedIntoId: string) {
    return this.prisma.case.update({
      where: { id },
      data: { mergedIntoId, status: 'CLOSED', closedAt: new Date() },
    });
  }
}
