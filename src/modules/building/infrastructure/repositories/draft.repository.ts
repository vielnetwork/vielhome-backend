import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/** Persistence for BuildingSetupDraft — the Zero Data Loss store for the wizard. */
@Injectable()
export class DraftRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveForPerson(personId: string) {
    return this.prisma.buildingSetupDraft.findFirst({
      where: { personId, submittedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  }

  findById(id: string) {
    return this.prisma.buildingSetupDraft.findUnique({ where: { id } });
  }

  async upsertForPerson(params: {
    personId: string;
    step: string;
    payload: Record<string, unknown>;
    device?: string;
  }) {
    const existing = await this.findActiveForPerson(params.personId);

    if (!existing) {
      return this.prisma.buildingSetupDraft.create({
        data: {
          personId: params.personId,
          step: params.step,
          payload: params.payload as Prisma.InputJsonValue,
          device: params.device,
        },
      });
    }

    const mergedPayload = {
      ...(existing.payload as Record<string, unknown>),
      ...params.payload,
    } as Prisma.InputJsonValue;

    return this.prisma.buildingSetupDraft.update({
      where: { id: existing.id },
      data: {
        step: params.step,
        payload: mergedPayload,
        device: params.device,
        revision: { increment: 1 },
      },
    });
  }

  markSubmitted(id: string) {
    return this.prisma.buildingSetupDraft.update({
      where: { id },
      data: { submittedAt: new Date() },
    });
  }
}
