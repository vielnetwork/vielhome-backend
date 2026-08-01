import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { BootstrapBackofficeAdminService } from '../src/modules/backoffice-bootstrap/application/bootstrap-backoffice-admin.service';
import { ConflictError, NotFoundAppError, ValidationError } from '../src/common/errors/app-error';
import type { AppConfig } from '../src/config/configuration';
import { createE2eRunId, E2E_SUITE_ID } from './helpers/e2e-identity';

// 21_ADRs > ADR-118 — Initial Backoffice Bootstrap.
//
// IMPORTANT SAFETY NOTE (read before touching this file): this suite
// deliberately NEVER runs `BootstrapBackofficeAdminService` against the
// real `'Technical Admin'` role name. `npm run test:e2e` runs every
// `*.e2e-spec.ts` file as a separate, concurrent Jest worker process, all
// pointed at the same shared dev Postgres database (see ADR-107), and
// this service's whole contract is "the FIRST active holder of a role
// wins, permanently, until manually revoked via the real RBAC API." If
// this suite ever bootstrapped a real `'Technical Admin'`, that account
// would persist forever in the shared dev database, and every subsequent
// real (or test) invocation would forever see "already exists" — a
// permanent, irreversible side effect from an automated test run. Every
// test below instead creates its OWN throwaway `Role` (a fresh, uniquely
// named row per run, mirroring every other suite's own throwaway-Role
// convention, e.g. `provider-settings.e2e-spec.ts`), passed explicitly
// via `roleName`, and cleans up everything it creates in `afterAll`.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.BOOTSTRAP_BACKOFFICE_ADMIN);
let phoneCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98915${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

async function bootstrapTestApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  const config = app.get(ConfigService<AppConfig, true>);
  app.setGlobalPrefix(config.get('apiPrefix', { infer: true }));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.init();

  return { app, prisma: app.get(PrismaService) };
}

async function requestOtpAndCaptureCode(
  app: INestApplication,
  phone: string,
  purpose: 'LOGIN' | 'REGISTER' | 'VERIFY_PHONE' = 'LOGIN',
): Promise<string> {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await request(app.getHttpServer())
    .post('/api/v1/auth/otp/request')
    .send({ phone, purpose })
    .expect(200);

  const line = logSpy.mock.calls.map((args) => String(args[0])).find((l) => l.includes(phone));
  logSpy.mockRestore();
  if (!line) throw new Error(`No OTP log line captured for ${phone}`);
  const match = line.match(/:\s*(\d+)\s*—/);
  if (!match) throw new Error(`Could not parse OTP code out of log line: ${line}`);
  return match[1];
}

function verifyOtp(app: INestApplication, params: { phone: string; code: string }) {
  return request(app.getHttpServer())
    .post('/api/v1/auth/otp/verify')
    .send({
      phone: params.phone,
      code: params.code,
      purpose: 'LOGIN',
      deviceToken: `e2e-${params.phone}-${params.code}`,
      platform: 'web',
    });
}

async function deleteOncePerPhoneBatch(prisma: PrismaService, phones: string[]): Promise<void> {
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { recipient: { phone: { in: phones } } } },
  });
  await prisma.notification.deleteMany({ where: { recipient: { phone: { in: phones } } } });
  await prisma.notificationPreference.deleteMany({
    where: { person: { phone: { in: phones } } },
  });
  await prisma.personAchievement.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.xpTransaction.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.refreshToken.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.device.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
  await prisma.staffRole.deleteMany({ where: { staff: { person: { phone: { in: phones } } } } });
  await prisma.platformStaff.deleteMany({ where: { person: { phone: { in: phones } } } });
  // AuditLog rows this suite writes are left in place, deliberately —
  // AuditLog is append-only/immutable (AuditService's own doc comment)
  // and no other e2e suite in this codebase deletes its own audit rows
  // either; they carry no FK to Person/PlatformStaff/StaffRole (entityId
  // is a plain string, not a real foreign key), so they never block this
  // cleanup.
  await prisma.person.deleteMany({ where: { phone: { in: phones } } });
}

async function cleanupPhones(prisma: PrismaService, phones: string[]): Promise<void> {
  if (phones.length === 0) return;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteOncePerPhoneBatch(prisma, phones);
      return;
    } catch (error) {
      const isForeignKeyError =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!isForeignKeyError || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

describe('Initial Backoffice Bootstrap (e2e) — ADR-118', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: BootstrapBackofficeAdminService;
  const createdPhones: string[] = [];
  const createdRoleIds: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    service = app.get(BootstrapBackofficeAdminService);
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    if (createdRoleIds.length > 0) {
      await prisma.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
      await prisma.role.deleteMany({ where: { id: { in: createdRoleIds } } });
    }
    await app.close();
  });

  async function makeThrowawayRole(label: string): Promise<{ id: string; name: string }> {
    const role = await prisma.role.create({
      data: {
        name: `E2E ADR-118 Bootstrap Test Role ${label} ${Date.now()}`,
        description: 'Created by bootstrap-backoffice-admin.e2e-spec.ts (ADR-118).',
      },
    });
    createdRoleIds.push(role.id);
    return role;
  }

  it('throws NotFoundAppError for a role name that does not exist in the seed catalog', async () => {
    await expect(
      service.run({ phone: nextPhone(), roleName: `Nonexistent Role ${RUN_ID}` }),
    ).rejects.toBeInstanceOf(NotFoundAppError);
  });

  it('creates a brand-new Person + PlatformStaff(PLATFORM_ADMIN) + StaffRole, and the account is fully functional for real OTP login', async () => {
    const role = await makeThrowawayRole('happy-path');
    const permission = await prisma.permission.findUnique({ where: { key: 'DASHBOARD_VIEW' } });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission!.id },
    });

    const phone = nextPhone();
    createdPhones.push(phone);

    const result = await service.run({ phone, fullName: 'ADR-118 E2E Admin', roleName: role.name });

    expect(result.status).toBe('CREATED');
    expect(result.roleName).toBe(role.name);
    expect(result.admin.phone).toBe(phone);
    expect(result.admin.fullName).toBe('ADR-118 E2E Admin');

    const platformStaff = await prisma.platformStaff.findUnique({
      where: { personId: result.admin.personId },
    });
    expect(platformStaff).not.toBeNull();
    expect(platformStaff!.role).toBe('PLATFORM_ADMIN');
    expect(platformStaff!.isActive).toBe(true);

    const staffRole = await prisma.staffRole.findUnique({
      where: { id: result.admin.staffRoleId },
    });
    expect(staffRole).not.toBeNull();
    expect(staffRole!.roleId).toBe(role.id);
    expect(staffRole!.revokedAt).toBeNull();
    expect(staffRole!.assignedById).toBeNull();

    const staffAudit = await prisma.auditLog.findFirst({
      where: { entityType: 'PlatformStaff', entityId: platformStaff!.id },
    });
    expect(staffAudit).not.toBeNull();
    expect(staffAudit!.action).toBe('PlatformStaffBootstrapped');
    expect(staffAudit!.actorId).toBeNull();
    expect((staffAudit!.metadata as Record<string, unknown>).source).toBe('SYSTEM_BOOTSTRAP');

    const roleAudit = await prisma.auditLog.findFirst({
      where: { entityType: 'StaffRole', entityId: staffRole!.id },
    });
    expect(roleAudit).not.toBeNull();
    expect(roleAudit!.action).toBe('StaffRoleAssigned');
    expect(roleAudit!.actorId).toBeNull();
    expect((roleAudit!.metadata as Record<string, unknown>).source).toBe('SYSTEM_BOOTSTRAP');

    // Fully functional for real Backoffice login + the newly-granted
    // permission actually opens a PLATFORM_ADMIN + DASHBOARD_VIEW route —
    // proves both the legacy rank AND the new RBAC grant work together
    // for a freshly bootstrapped account, exactly as a real operator
    // would exercise it.
    const code = await requestOtpAndCaptureCode(app, phone);
    const loginRes = await verifyOtp(app, { phone, code }).expect(200);
    const accessToken = loginRes.body.data.accessToken;

    await request(app.getHttpServer())
      .get('/api/v1/backoffice/dashboard/overview')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it('is idempotent — a second run against the same role returns ALREADY_EXISTS with the SAME staffRoleId, and writes no new audit rows', async () => {
    const role = await makeThrowawayRole('idempotent');
    const permission = await prisma.permission.findUnique({ where: { key: 'DASHBOARD_VIEW' } });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission!.id },
    });

    const firstPhone = nextPhone();
    createdPhones.push(firstPhone);
    const first = await service.run({ phone: firstPhone, roleName: role.name });
    expect(first.status).toBe('CREATED');

    const auditCountAfterFirst = await prisma.auditLog.count({
      where: { entityType: 'StaffRole', entityId: first.admin.staffRoleId },
    });

    // Second call — even with a DIFFERENT phone supplied, an active
    // holder already exists, so this must short-circuit and never touch
    // the second phone at all.
    const secondPhone = nextPhone();
    const second = await service.run({ phone: secondPhone, roleName: role.name });

    expect(second).toEqual({
      status: 'ALREADY_EXISTS',
      roleName: role.name,
      admin: first.admin,
    });

    const secondPersonExists = await prisma.person.findUnique({ where: { phone: secondPhone } });
    expect(secondPersonExists).toBeNull();

    const auditCountAfterSecond = await prisma.auditLog.count({
      where: { entityType: 'StaffRole', entityId: first.admin.staffRoleId },
    });
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);
  });

  it('throws ValidationError when no phone is available and no admin exists yet for that role', async () => {
    const role = await makeThrowawayRole('no-phone');

    await expect(service.run({ roleName: role.name })).rejects.toBeInstanceOf(ValidationError);
  });

  it('reuses an existing, unsuspended Person by phone instead of creating a duplicate', async () => {
    const role = await makeThrowawayRole('reuse-existing-person');
    const phone = nextPhone();
    createdPhones.push(phone);

    const existingPerson = await prisma.person.create({
      data: { phone, fullName: 'Pre-existing Real User' },
    });

    const result = await service.run({ phone, roleName: role.name });

    expect(result.status).toBe('CREATED');
    expect(result.admin.personId).toBe(existingPerson.id);
    // fullName is left untouched — the pre-existing person's own name is
    // never silently overwritten by the bootstrap script's default.
    expect(result.admin.fullName).toBe('Pre-existing Real User');

    const personCount = await prisma.person.count({ where: { phone } });
    expect(personCount).toBe(1);
  });

  it('refuses to bootstrap a suspended person (ConflictError), and creates no PlatformStaff/StaffRole', async () => {
    const role = await makeThrowawayRole('suspended-guard');
    const phone = nextPhone();
    createdPhones.push(phone);
    await prisma.person.create({
      data: { phone, fullName: 'Suspended Person', isSuspended: true },
    });

    await expect(service.run({ phone, roleName: role.name })).rejects.toBeInstanceOf(ConflictError);

    const grants = await prisma.staffRole.findMany({ where: { roleId: role.id } });
    expect(grants).toHaveLength(0);
  });
});
