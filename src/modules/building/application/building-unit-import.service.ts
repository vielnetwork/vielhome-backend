import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ConflictError, ValidationError } from '../../../common/errors/app-error';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UnitCreatedEvent } from '../events/unit-created.event';
import { normalizeUnitNumber, readUnitWorkbook, unitImportTemplate, type ImportContact } from './unit-import-workbook';

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
        tenancies: { where: { isCurrent: true }, select: { id: true, startDate: true, endDate: true, person: { select: { phone: true, firstName: true, lastName: true } } }, take: 1 },
        ownerships: { where: { isCurrent: true }, select: { person: { select: { phone: true, firstName: true, lastName: true } } } },
        importContacts: { orderBy: { role: 'asc' } },
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
      contacts: (['OWNER', 'TENANT'] as const).flatMap((role) => {
        const person = role === 'OWNER' ? unit.ownerships[0]?.person : unit.tenancies[0]?.person;
        const pending = unit.importContacts.find((item) => item.role === role && !item.acceptedAt);
        const contact = person ?? pending;
        if (!contact?.firstName || !contact.lastName) return [];
        const leaseEndDate = role === 'TENANT'
          ? unit.tenancies[0]?.endDate ?? pending?.leaseEndDate ?? undefined : undefined;
        return [{ role, phone: contact.phone, firstName: contact.firstName, lastName: contact.lastName, leaseEndDate }];
      }),
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
    const contactUpdates: Array<{ unitNumber: string; unitId?: string; contact: ImportContact }> = [];
    const leaseUpdates: Array<{ id: string; endDate: Date }> = [];
    for (const { data, row } of workbook.rows) {
      const { unitNumber, contacts = [], ...fields } = data;
      const matches = byNumber.get(unitNumber) ?? [];
      if (matches.length > 1) {
        errors.push({ row, code: 'ambiguous' });
        continue;
      }
      const unit = matches[0];
      const hasTenant = (unit?.tenancies.length ?? 0) > 0;
      if (!hasTenant && fields.occupancyStatus === 'TENANT_OCCUPIED' && contacts.some((item) => item.role === 'TENANT')) {
        delete fields.occupancyStatus;
      }
      if (fields.occupancyStatus && fields.occupancyStatus !== unit?.occupancyStatus &&
          (fields.occupancyStatus === 'TENANT_OCCUPIED') !== hasTenant) {
        errors.push({ row, code: hasTenant ? 'activeLease' : 'missingLease' });
        continue;
      }
      for (const contact of contacts) {
        const activePhones = contact.role === 'OWNER'
          ? unit?.ownerships?.map((ownership) => ownership.person.phone)
          : unit?.tenancies.map((tenancy) => tenancy.person.phone);
        if (activePhones?.length) {
          if (!activePhones.includes(contact.phone)) {
            errors.push({ row, code: 'activeContact' });
          } else if (contact.role === 'TENANT' && contact.leaseEndDate) {
            const tenancy = unit!.tenancies[0];
            const end = contact.leaseEndDate.toISOString().slice(0, 10);
            if (end <= tenancy.startDate.toISOString().slice(0, 10)) {
              errors.push({ row, code: 'leaseDate' });
            } else if (tenancy.endDate?.toISOString().slice(0, 10) !== end) {
              leaseUpdates.push({ id: tenancy.id, endDate: contact.leaseEndDate });
            }
          }
          continue;
        }
        const previous = unit?.importContacts?.find((item) => item.role === contact.role);
        if (!previous || previous.acceptedAt || previous.phone !== contact.phone || previous.firstName !== contact.firstName ||
            previous.lastName !== contact.lastName ||
            (contact.leaseEndDate && previous.leaseEndDate?.getTime() !== contact.leaseEndDate.getTime())) {
          contactUpdates.push({ unitId: unit?.id, unitNumber, contact });
        }
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
    return { errors, creates, updates, contactUpdates, leaseUpdates, revision };
  }

  async preview(buildingId: string, file: Buffer) {
    const workbook = await readUnitWorkbook(file);
    const plan = await this.plan(this.prisma, buildingId, file, workbook);
    return {
      revision: plan.revision, created: plan.creates.length, updated: plan.updates.length,
      contacts: plan.contactUpdates.length + plan.leaseUpdates.length,
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
        for (const { id, endDate } of plan.leaseUpdates) {
          await tx.tenancy.update({ where: { id, isCurrent: true }, data: { endDate } });
        }
        const newUnits = plan.contactUpdates.some((item) => !item.unitId)
          ? await tx.unit.findMany({
              where: { buildingId, unitNumber: { in: plan.creates.map((unit) => unit.unitNumber) } },
              select: { id: true, unitNumber: true },
            }) : [];
        const ids = new Map(newUnits.map((unit) => [unit.unitNumber, unit.id]));
        for (const item of plan.contactUpdates) {
          const unitId = item.unitId ?? ids.get(item.unitNumber);
          if (!unitId) throw new ConflictError('UNIT_IMPORT_PREVIEW_EXPIRED');
          await tx.unitImportContact.upsert({
            where: { unitId_role: { unitId, role: item.contact.role } },
            create: { unitId, ...item.contact },
            update: { ...item.contact, invitedAt: null, invitedById: null, acceptedAt: null },
          });
        }
        if (created.length || plan.updates.length || plan.contactUpdates.length || plan.leaseUpdates.length) {
          await tx.auditLog.create({ data: {
            actorId: personId, buildingId, requestId,
            action: 'UnitsImported', entityType: 'Building', entityId: buildingId,
            metadata: {
              created: created.map(({ id }) => id), updated: plan.updates.map(({ id }) => id),
              leaseUpdates: plan.leaseUpdates.map(({ id }) => id), contacts: plan.contactUpdates.length,
            },
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
