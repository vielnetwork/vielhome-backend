import { ProviderSettingsService } from './provider-settings.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import { EmailProviderService } from '../../../common/notification-providers/email-provider.service';
import { SmsProviderService } from '../../../common/notification-providers/sms-provider.service';
import { PushProviderService } from '../../../common/notification-providers/push-provider.service';

function makePrisma(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    providerSetting: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      ...overrides,
    },
  } as unknown as PrismaService;
}

function makeAudit(): AuditService {
  return { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
}

function makeProviders(configured: { email?: boolean; sms?: boolean; push?: boolean } = {}) {
  return {
    email: {
      isConfigured: jest.fn().mockReturnValue(configured.email ?? true),
    } as unknown as EmailProviderService,
    sms: {
      isConfigured: jest.fn().mockReturnValue(configured.sms ?? true),
    } as unknown as SmsProviderService,
    push: {
      isConfigured: jest.fn().mockReturnValue(configured.push ?? true),
    } as unknown as PushProviderService,
  };
}

const NOW = new Date('2026-08-01T12:00:00.000Z');

describe('ProviderSettingsService', () => {
  describe('boot / safe defaults', () => {
    it('defaults every provider to enabled when no rows exist yet', async () => {
      const prisma = makePrisma();
      const { email, sms, push } = makeProviders();
      const service = new ProviderSettingsService(prisma, makeAudit(), email, sms, push);

      await service.onModuleInit();

      expect(service.isEnabled('EMAIL')).toBe(true);
      expect(service.isEnabled('SMS')).toBe(true);
      expect(service.isEnabled('PUSH')).toBe(true);
    });

    it('loads real persisted state at boot', async () => {
      const prisma = makePrisma({
        findMany: jest.fn().mockResolvedValue([
          {
            key: 'SMS',
            enabled: false,
            reason: 'Vendor outage',
            updatedAt: NOW,
            updatedById: 'staff-1',
          },
        ]),
      });
      const { email, sms, push } = makeProviders();
      const service = new ProviderSettingsService(prisma, makeAudit(), email, sms, push);

      await service.onModuleInit();

      expect(service.isEnabled('SMS')).toBe(false);
      expect(service.isEnabled('EMAIL')).toBe(true);
      expect(service.isEnabled('PUSH')).toBe(true);
    });

    it('defaults every provider to enabled (never throws) if loading state at boot fails', async () => {
      const prisma = makePrisma({ findMany: jest.fn().mockRejectedValue(new Error('DB down')) });
      const { email, sms, push } = makeProviders();
      const service = new ProviderSettingsService(prisma, makeAudit(), email, sms, push);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(service.isEnabled('EMAIL')).toBe(true);
    });
  });

  describe('list', () => {
    it("shapes all three keys, merging the DB enabled/reason with each provider's own isConfigured()", async () => {
      const prisma = makePrisma({
        findMany: jest.fn().mockResolvedValue([
          {
            key: 'SMS',
            enabled: false,
            reason: 'Vendor outage',
            updatedAt: NOW,
            updatedById: 'staff-1',
          },
        ]),
      });
      const { email, sms, push } = makeProviders({ email: true, sms: false, push: true });
      const service = new ProviderSettingsService(prisma, makeAudit(), email, sms, push);

      const result = await service.list();

      expect(result).toEqual([
        {
          key: 'EMAIL',
          enabled: true,
          configured: true,
          reason: null,
          updatedAt: null,
          updatedById: null,
        },
        {
          key: 'SMS',
          enabled: false,
          configured: false,
          reason: 'Vendor outage',
          updatedAt: NOW.toISOString(),
          updatedById: 'staff-1',
        },
        {
          key: 'PUSH',
          enabled: true,
          configured: true,
          reason: null,
          updatedAt: null,
          updatedById: null,
        },
      ]);
    });
  });

  describe('setEnabled', () => {
    it('throws NotFoundAppError for an unknown key and never writes', async () => {
      const prisma = makePrisma();
      const { email, sms, push } = makeProviders();
      const service = new ProviderSettingsService(prisma, makeAudit(), email, sms, push);

      await expect(
        service.setEnabled(
          'BOGUS' as never,
          { enabled: false, reason: 'test' },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(
        (prisma as unknown as { providerSetting: { upsert: jest.Mock } }).providerSetting.upsert,
      ).not.toHaveBeenCalled();
    });

    it('upserts the row, updates the live cache immediately, and audits with before/after and no reason leakage beyond the field itself', async () => {
      const upsert = jest.fn().mockResolvedValue({
        key: 'SMS',
        enabled: false,
        reason: 'Vendor outage',
        updatedAt: NOW,
        updatedById: 'actor-1',
      });
      const prisma = makePrisma({
        findUnique: jest.fn().mockResolvedValue({ key: 'SMS', enabled: true }),
        upsert,
      });
      const audit = makeAudit();
      const { email, sms, push } = makeProviders({ sms: false });
      const service = new ProviderSettingsService(prisma, audit, email, sms, push);

      const result = await service.setEnabled(
        'SMS',
        { enabled: false, reason: 'Vendor outage' },
        'actor-1',
        'req-1',
      );

      expect(upsert).toHaveBeenCalledWith({
        where: { key: 'SMS' },
        create: { key: 'SMS', enabled: false, reason: 'Vendor outage', updatedById: 'actor-1' },
        update: { enabled: false, reason: 'Vendor outage', updatedById: 'actor-1' },
      });
      expect(service.isEnabled('SMS')).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'actor-1',
          action: 'ProviderDisabledByAdmin',
          entityType: 'ProviderSetting',
          entityId: 'SMS',
          reason: 'Vendor outage',
          requestId: 'req-1',
          metadata: { before: { enabled: true }, after: { enabled: false } },
        }),
      );
      expect(result).toEqual({
        key: 'SMS',
        enabled: false,
        configured: false,
        reason: 'Vendor outage',
        updatedAt: NOW.toISOString(),
        updatedById: 'actor-1',
      });
    });

    it('records ProviderEnabledByAdmin when re-enabling', async () => {
      const upsert = jest.fn().mockResolvedValue({
        key: 'EMAIL',
        enabled: true,
        reason: 'Vendor recovered',
        updatedAt: NOW,
        updatedById: 'actor-1',
      });
      const prisma = makePrisma({
        findUnique: jest.fn().mockResolvedValue({ key: 'EMAIL', enabled: false }),
        upsert,
      });
      const audit = makeAudit();
      const { email, sms, push } = makeProviders();
      const service = new ProviderSettingsService(prisma, audit, email, sms, push);

      await service.setEnabled(
        'EMAIL',
        { enabled: true, reason: 'Vendor recovered' },
        'actor-1',
        'req-1',
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ProviderEnabledByAdmin' }),
      );
    });
  });
});
