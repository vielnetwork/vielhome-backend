import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictError, ValidationError } from '../../../common/errors/app-error';
import { BuildingUnitImportService } from './building-unit-import.service';
import { unitImportTemplate } from './unit-import-workbook';

describe('Excel unit import', () => {
  const unit = {
    id: 'unit-1', unitNumber: '۱', type: 'RESIDENTIAL',
    floorNumber: 2, areaSqm: 90, parkingCount: 1, storageCount: null,
    occupancyStatus: 'VACANT', tenancies: [],
  };

  function setup() {
    const db = {
      unit: {
        findMany: jest.fn().mockResolvedValue([unit]),
        createManyAndReturn: jest.fn().mockResolvedValue([{ id: 'unit-2' }]),
        update: jest.fn().mockResolvedValue(unit),
      },
      auditLog: { create: jest.fn() },
      unitImportContact: { upsert: jest.fn() },
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation((operation) => operation(db));
    const events = new EventEmitter2();
    return { db, service: new BuildingUnitImportService(db as never, events) };
  }

  it('previews additions and edits, then applies both without overwriting blank fields', async () => {
    const { db, service } = setup();
    const file = await unitImportTemplate([
      { unitNumber: '1', areaSqm: 92 },
      { unitNumber: '۲', type: 'COMMERCIAL' },
    ]);
    const preview = await service.preview('building', file);
    expect(preview).toMatchObject({ created: 1, updated: 1, errors: [] });
    expect(db.$transaction).not.toHaveBeenCalled();
    await expect(service.apply('building', 'manager', 'request', file, preview.revision))
      .resolves.toEqual({ created: 1, updated: 1 });
    expect(db.unit.update).toHaveBeenCalledWith({
      where: { id: 'unit-1' }, data: { areaSqm: 92 },
    });
    expect(db.unit.createManyAndReturn).toHaveBeenCalledWith({
      data: [{ buildingId: 'building', unitNumber: '2', type: 'COMMERCIAL' }],
      select: { id: true },
    });
  });

  it('rejects a changed building snapshot before writing rows', async () => {
    const { db, service } = setup();
    const file = await unitImportTemplate([{ unitNumber: '1', areaSqm: 92 }]);
    const preview = await service.preview('building', file);
    db.unit.findMany.mockResolvedValue([{ ...unit, parkingCount: 2 }]);
    await expect(service.apply('building', 'manager', 'request', file, preview.revision))
      .rejects.toBeInstanceOf(ConflictError);
    expect(db.unit.update).not.toHaveBeenCalled();
  });

  it('reports duplicate numbers and conflicts with lease records by row', async () => {
    const { db, service } = setup();
    const file = await unitImportTemplate([
      { unitNumber: '۱', occupancyStatus: 'TENANT_OCCUPIED' },
      { unitNumber: '1', areaSqm: 92 },
    ]);
    const preview = await service.preview('building', file);
    expect(preview.errors).toEqual([
      { row: 2, code: 'missingLease' }, { row: 3, code: 'duplicate' },
    ]);
    await expect(service.apply('building', 'manager', 'request', file, preview.revision))
      .rejects.toBeInstanceOf(ValidationError);
    expect(db.unit.update).not.toHaveBeenCalled();
  });

  it('normalizes contact phones and stages invitations without granting access', async () => {
    const { db, service } = setup();
    const file = await unitImportTemplate([{ unitNumber: '1', contacts: [
      { role: 'OWNER', phone: '۰۹۱۲۱۲۳۴۵۶۷', firstName: 'علی', lastName: 'احمدی' },
      { role: 'TENANT', phone: '09121234568', firstName: 'سارا', lastName: 'رضایی', leaseEndDate: new Date('2028-05-31') },
    ] }]);
    const preview = await service.preview('building', file);
    expect(preview).toMatchObject({ contacts: 2, created: 0, updated: 0, errors: [] });
    expect(db.unitImportContact.upsert).not.toHaveBeenCalled();
    await service.apply('building', 'manager', 'request', file, preview.revision);
    expect(db.unitImportContact.upsert).toHaveBeenCalledTimes(2);
    expect(db.unitImportContact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ role: 'OWNER', phone: '+989121234567' }),
    }));
    expect(db.unitImportContact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ role: 'TENANT', leaseEndDate: new Date('2028-05-31') }),
    }));
    expect(db.unit.update).not.toHaveBeenCalled();
  });
});
