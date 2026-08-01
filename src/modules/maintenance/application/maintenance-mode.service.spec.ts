import { MaintenanceModeService } from './maintenance-mode.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';

function makePrisma(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    maintenanceModeState: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      ...overrides,
    },
  } as unknown as PrismaService;
}

function makeAudit(): AuditService {
  return { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
}

const NOW = new Date('2026-08-01T12:00:00.000Z');

describe('MaintenanceModeService', () => {
  describe('boot / safe defaults', () => {
    it('defaults to disabled when no state row exists yet', async () => {
      const prisma = makePrisma({ findUnique: jest.fn().mockResolvedValue(null) });
      const service = new MaintenanceModeService(prisma, makeAudit());

      await service.onModuleInit();

      expect(service.isEnabled()).toBe(false);
      expect(service.getStatus()).toMatchObject({ enabled: false, reason: null });
    });

    it('loads real persisted state at boot', async () => {
      const prisma = makePrisma({
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          reason: 'Scheduled DB upgrade',
          message: 'Back in 30 minutes',
          updatedAt: NOW,
          updatedById: 'staff-1',
        }),
      });
      const service = new MaintenanceModeService(prisma, makeAudit());

      await service.onModuleInit();

      expect(service.isEnabled()).toBe(true);
      expect(service.getStatus()).toEqual({
        enabled: true,
        reason: 'Scheduled DB upgrade',
        message: 'Back in 30 minutes',
        updatedAt: NOW.toISOString(),
        updatedById: 'staff-1',
      });
    });

    it('defaults to disabled (never throws) if loading state at boot fails', async () => {
      const prisma = makePrisma({ findUnique: jest.fn().mockRejectedValue(new Error('DB down')) });
      const service = new MaintenanceModeService(prisma, makeAudit());

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('setEnabled', () => {
    it('enables maintenance mode, updates the in-memory cache synchronously, and records an audit entry', async () => {
      const upsert = jest.fn().mockResolvedValue({
        enabled: true,
        reason: 'Emergency hotfix',
        message: null,
        updatedAt: NOW,
        updatedById: 'staff-1',
      });
      const prisma = makePrisma({ upsert });
      const audit = makeAudit();
      const service = new MaintenanceModeService(prisma, audit);

      const result = await service.setEnabled(
        { enabled: true, reason: 'Emergency hotfix' },
        'staff-1',
        'req-1',
      );

      expect(result.enabled).toBe(true);
      // The cache must reflect the write immediately — no separate reload.
      expect(service.isEnabled()).toBe(true);
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'singleton' } }));
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'staff-1',
          action: 'MaintenanceModeEnabled',
          entityType: 'MaintenanceModeState',
          reason: 'Emergency hotfix',
          requestId: 'req-1',
        }),
      );
    });

    it('disabling records MaintenanceModeDisabled, not MaintenanceModeEnabled', async () => {
      const upsert = jest.fn().mockResolvedValue({
        enabled: false,
        reason: 'All clear',
        message: null,
        updatedAt: NOW,
        updatedById: 'staff-1',
      });
      const audit = makeAudit();
      const service = new MaintenanceModeService(makePrisma({ upsert }), audit);

      await service.setEnabled({ enabled: false, reason: 'All clear' }, 'staff-1', 'req-2');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MaintenanceModeDisabled' }),
      );
    });

    it('is idempotent: re-affirming the same enabled value still succeeds and still audits', async () => {
      const upsert = jest.fn().mockResolvedValue({
        enabled: true,
        reason: 'Still ongoing',
        message: null,
        updatedAt: NOW,
        updatedById: 'staff-1',
      });
      const audit = makeAudit();
      const service = new MaintenanceModeService(makePrisma({ upsert }), audit);

      await service.setEnabled({ enabled: true, reason: 'First' }, 'staff-1', 'req-3');
      await service.setEnabled({ enabled: true, reason: 'Still ongoing' }, 'staff-1', 'req-4');

      expect(upsert).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenCalledTimes(2);
      expect(service.isEnabled()).toBe(true);
    });
  });
});
