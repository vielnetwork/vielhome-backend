import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ConflictError, ValidationError } from '../../../common/errors/app-error';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UnitCreatedEvent } from '../events/unit-created.event';
import { normalizeUnitNumber, readUnitWorkbook, unitImportTemplate } from './unit-import-workbook';

@Injectable()
export class BuildingUnitImportService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventEmitter2) {}

  private snapshot(client: Prisma.TransactionClient, buildingId: string) {
    return client.unit.findMany({
      where: { buildingId },
      orderBy: [{ unitNumber: 'asc' }, { id: 'asc' }],
      select: {
        id: true, unitNumber: true, type: true, floorNumber: true, areaSqm: true,
        parkingCount: true, storageCount: true, occupancyStatus: true,
        tenancies: { where: { isCurrent: true }, select: { id: true }, take: 1 },
      },
    });
  }

  async template(buildingId: string) {
    const units = await this.snapshot(this.prisma, buildingId);
    const file = await unitImportTemplate(units.map((unit) => ({
      ...unit,
      floorNumber: unit.floorNumber ?? undefined,
      areaSqm: unit.areaSqm ?? undefined,
      parkingCount: unit.parkingCount ?? undefined,
      storageCount: unit.storageCount ?? undefined,
    })));
    return { data: file.toString('base64'), fileName: 'vielhome-units.xlsx' };
  }

  private async plan(client: Prisma.TransactionClient, buildingId: string, file: Buffer,
    workbook: Awaited<ReturnType<typeof readUnitWorkbook>>) {
    const records = await this.snapshot(client, buildingId);
    const byNumber = new Map<string, Array<(typeof records)[number]>>();
    for (const unit of records) {
      const number = normalizeUnitNumber(unit.unitNumber);
      const matches = byNumber.get(number) ?? [];
      matches.push(unit);
      byNumber.set(number, matches);
    }
    const errors = [...workbook.errors];
    const creates: Prisma.UnitCreateManyInput[] = [];
    const updates: Array<{ id: string; data: Prisma.UnitUpdateInput }> = [];
    for (const { data, row } of workbook.rows) {
      const { unitNumber, ...fields } = data;
      const matches = byNumber.get(unitNumber) ?? [];
      if (matches.length > 1) {
        errors.push({ row, code: 'ambiguous' });
        continue;
      }
      const unit = matches[0];
      const hasTenant = (unit?.tenancies.length ?? 0) > 0;
      if (fields.occupancyStatus && fields.occupancyStatus !== unit?.occupancyStatus &&
          (fields.occupancyStatus === 'TENANT_OCCUPIED') !== hasTenant) {
        errors.push({ row, code: hasTenant ? 'activeLease' : 'missingLease' });
        continue;
      }
      if (!unit) {
        creates.push({ buildingId, unitNumber, ...fields });
      } else if (Object.entries(fields).some(([key, value]) =>
        value !== undefined && unit[key as keyof typeof fields] !== value,
      )) {
        updates.push({ id: unit.id, data: fields });
      }
    }
    const revision = createHash('sha256').update(buildingId).update(file)
      .update(JSON.stringify(records)).digest('hex');
    return { errors, creates, updates, revision };
  }

  async preview(buildingId: string, file: Buffer) {
    const workbook = await readUnitWorkbook(file);
    const plan = await this.plan(this.prisma, buildingId, file, workbook);
    return {
      revision: plan.revision, created: plan.creates.length, updated: plan.updates.length,
      errors: plan.errors.sort((a, b) => a.row - b.row),
    };
  }

  async apply(buildingId: string, personId: string, requestId: string, file: Buffer, revision: string) {
    const workbook = await readUnitWorkbook(file);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const plan = await this.plan(tx, buildingId, file, workbook);
        if (plan.errors.length) throw new ValidationError('INVALID_UNIT_ROWS');
        if (plan.revision !== revision) throw new ConflictError('UNIT_IMPORT_PREVIEW_EXPIRED');
        const created = plan.creates.length
          ? await tx.unit.createManyAndReturn({ data: plan.creates, select: { id: true } })
          : [];
        for (const { id, data } of plan.updates) await tx.unit.update({ where: { id }, data });
        if (created.length || plan.updates.length) {
          await tx.auditLog.create({ data: {
            actorId: personId, buildingId, requestId,
            action: 'UnitsImported', entityType: 'Building', entityId: buildingId,
            metadata: { created: created.map(({ id }) => id), updated: plan.updates.map(({ id }) => id) },
          } });
        }
        return { created, updated: plan.updates.length };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 });
      for (const { id } of result.created) {
        this.events.emit('UnitCreated', new UnitCreatedEvent(id, buildingId, personId));
      }
      return { created: result.created.length, updated: result.updated };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2002', 'P2034'].includes(error.code)) {
        throw new ConflictError('UNIT_IMPORT_PREVIEW_EXPIRED');
      }
      throw error;
    }
  }
}
