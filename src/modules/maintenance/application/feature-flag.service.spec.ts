import { FeatureFlagService } from './feature-flag.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import {
  DuplicateError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';

function makePrisma(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    featureFlag: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      ...overrides,
    },
  } as unknown as PrismaService;
}

function makeAudit(): AuditService {
  return { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
}

describe('FeatureFlagService', () => {
  describe('list', () => {
    it('applies pagination and returns meta alongside items', async () => {
      const findMany = jest.fn().mockResolvedValue([{ id: '1', key: 'A' }]);
      const count = jest.fn().mockResolvedValue(1);
      const service = new FeatureFlagService(makePrisma({ findMany, count }), makeAudit());

      const result = await service.list({}, { page: 1, limit: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
    });
  });

  describe('getByKey', () => {
    it('throws NotFoundAppError when no flag matches', async () => {
      const service = new FeatureFlagService(
        makePrisma({ findUnique: jest.fn().mockResolvedValue(null) }),
        makeAudit(),
      );

      await expect(service.getByKey('NOPE')).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('create', () => {
    it('throws DuplicateError when the key already exists', async () => {
      const service = new FeatureFlagService(
        makePrisma({ findUnique: jest.fn().mockResolvedValue({ id: 'existing' }) }),
        makeAudit(),
      );

      await expect(
        service.create({ key: 'EXISTING', label: 'x', reason: 'test' }, 'staff-1', 'req-1'),
      ).rejects.toBeInstanceOf(DuplicateError);
    });

    it('defaults enabled to false and records an audit entry on success', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'f1', key: 'NEW_FLAG', enabled: false });
      const audit = makeAudit();
      const service = new FeatureFlagService(
        makePrisma({ findUnique: jest.fn().mockResolvedValue(null), create }),
        audit,
      );

      const result = await service.create(
        { key: 'NEW_FLAG', label: 'New Flag', reason: 'rollout prep' },
        'staff-1',
        'req-1',
      );

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }),
      );
      expect(result.key).toBe('NEW_FLAG');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'FeatureFlagCreated', reason: 'rollout prep' }),
      );
    });
  });

  describe('update', () => {
    it('throws ValidationError when neither enabled nor description is provided', async () => {
      const service = new FeatureFlagService(makePrisma(), makeAudit());

      await expect(
        service.update('SOME_FLAG', { reason: 'no-op attempt' }, 'staff-1', 'req-1'),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('merges the provided field(s), preserves the other, and audits before/after', async () => {
      const existing = { id: 'f1', key: 'SOME_FLAG', enabled: false, description: 'old desc' };
      const updated = { id: 'f1', key: 'SOME_FLAG', enabled: true, description: 'old desc' };
      const findUnique = jest.fn().mockResolvedValue(existing);
      const update = jest.fn().mockResolvedValue(updated);
      const audit = makeAudit();
      const service = new FeatureFlagService(makePrisma({ findUnique, update }), audit);

      const result = await service.update(
        'SOME_FLAG',
        { enabled: true, reason: 'turning it on' },
        'staff-1',
        'req-1',
      );

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ enabled: true, description: 'old desc' }),
        }),
      );
      expect(result.enabled).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'FeatureFlagUpdated',
          metadata: expect.objectContaining({
            before: { enabled: false, description: 'old desc' },
            after: { enabled: true, description: 'old desc' },
          }),
        }),
      );
    });
  });
});
