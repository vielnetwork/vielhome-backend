import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/modules/foundation/auth/application/auth.service';
import type { AppConfig } from '../src/config/configuration';

/**
 * 21_ADRs > ADR-099 (architecture: ADR-098) — Backoffice RBAC Foundation.
 *
 * Follows this test-phase series' own established per-file convention
 * (bootstrapTestApp/registerPerson/loginAsSeededStaff duplicated locally,
 * not imported — see `test/marketplace.e2e-spec.ts`'s own header comment
 * for why).
 *
 * NOT covered here (deliberately, per ADR-099's own non-goals): no
 * existing Backoffice controller's routes are exercised or modified by
 * this file, and `PermissionsGuard`/`@RequiresPermission` are not attached
 * to any route — this file only exercises the management/resolution
 * endpoints `RbacManagementController`/`PermissionResolutionController`
 * ship with, plus the resolver's own behavior through those endpoints.
 * Confirming zero behavior change on the 14 pre-existing controllers is a
 * regression check against THEIR OWN existing e2e suites, not new
 * assertions added here.
 *
 * Role/Permission reference data is created idempotently (find-or-create)
 * in `beforeAll`, not assumed pre-seeded by `npm run db:seed:rbac` — this
 * file does not depend on seed execution order.
 */
const RUN_ID = `${Date.now().toString().slice(-3)}${process.pid.toString().slice(-2)}`;
let phoneCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98913${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
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

async function deleteOncePerPhoneBatch(prisma: PrismaService, phones: string[]): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.device.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { recipient: { phone: { in: phones } } } },
  });
  await prisma.notification.deleteMany({ where: { recipient: { phone: { in: phones } } } });
  await prisma.notificationPreference.deleteMany({
    where: { person: { phone: { in: phones } } },
  });
  await prisma.personAchievement.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.xpTransaction.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.buildingSetupDraft.deleteMany({ where: { person: { phone: { in: phones } } } });
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

/** RBAC-specific teardown: closes (not deletes — history preservation is
 * the whole point) any StaffRole this run created, and hard-deletes the
 * rows this run's own dedicated test Role/Permission ended up with, so
 * repeated CI runs don't accumulate garbage rows across test executions.
 *
 * `staffIds` here is the SHARED seeded platform admin's `PlatformStaff.id`
 * — other e2e files (`manager-verification.e2e-spec.ts`,
 * `scheduler.e2e-spec.ts`, etc.) grant roles to that exact same staff
 * record concurrently when `npm run test:e2e` runs suites across parallel
 * Jest workers against one shared dev database. A `staffId`-only
 * predicate here previously deleted every active `StaffRole` for that
 * staff member regardless of which role it pointed to — including
 * another suite's own concurrently-active grant — causing its permission
 * to "disappear" mid-run and its own later `staffRole.delete({id})` to
 * fail with "record not found." Scoping to this file's own `roleIds` too
 * (each a uniquely-named, exclusively-owned fixture role) ensures this
 * only ever deletes StaffRole rows this file itself created. */
async function cleanupRbacFixtures(
  prisma: PrismaService,
  staffIds: string[],
  roleIds: string[],
): Promise<void> {
  if (staffIds.length && roleIds.length) {
    await prisma.staffRole.deleteMany({
      where: { staffId: { in: staffIds }, roleId: { in: roleIds } },
    });
  }
  if (roleIds.length) {
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
  }
}

async function requestOtpAndCaptureCode(app: INestApplication, phone: string): Promise<string> {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await request(app.getHttpServer())
    .post('/api/v1/auth/otp/request')
    .send({ phone, purpose: 'LOGIN' })
    .expect(200);

  const line = logSpy.mock.calls.map((args) => String(args[0])).find((l) => l.includes(phone));
  logSpy.mockRestore();
  if (!line) throw new Error(`No OTP log line captured for ${phone}`);
  const match = line.match(/:\s*(\d+)\s*—/);
  if (!match) throw new Error(`Could not parse OTP code out of log line: ${line}`);
  return match[1];
}

async function requestOtpAndCaptureCodeDirect(app: INestApplication, phone: string): Promise<string> {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await app.get(AuthService).requestOtp({ phone, purpose: 'LOGIN' }, 'test-direct-otp-request');

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

interface RegisteredPerson {
  phone: string;
  personId: string;
  accessToken: string;
}

async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

const PLATFORM_ADMIN_PHONE = '+989120000000'; // prisma/seed.ts's own Dev Tester, seeded PLATFORM_ADMIN
const PLATFORM_REVIEWER_PHONE = '+989120000001'; // prisma/seed.ts's own BackOffice Reviewer, seeded REVIEWER

async function loginAsSeededStaff(app: INestApplication, phone: string): Promise<RegisteredPerson> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = await requestOtpAndCaptureCodeDirect(app, phone);
    const res = await verifyOtp(app, { phone, code });
    if (res.status === 200) {
      return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
    }
    if (attempt === maxAttempts) {
      throw new Error(
        `loginAsSeededStaff(${phone}) failed after ${maxAttempts} attempts: ` +
          `${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
  throw new Error('unreachable');
}

describe('Backoffice RBAC Foundation (ADR-099)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdStaffIds: string[] = [];
  const createdRoleIds: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let testRoleId: string;
  let testPermissionId: string;
  let adminStaffId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);

    plainPerson = await registerPerson(app);
    createdPhones.push(plainPerson.phone);

    const adminStaff = await prisma.platformStaff.findUnique({ where: { personId: admin.personId } });
    adminStaffId = adminStaff!.id;

    // Idempotent, find-or-create — does not assume `npm run db:seed:rbac`
    // has run in this environment.
    const permission =
      (await prisma.permission.findUnique({ where: { key: 'MARKETPLACE_APPROVE' } })) ??
      (await prisma.permission.create({
        data: {
          key: 'MARKETPLACE_APPROVE',
          label: 'Approve/Reject Marketplace Listings',
          description: 'e2e fixture (created only if seed had not already run).',
        },
      }));
    testPermissionId = permission.id;

    const role = await prisma.role.create({
      data: { name: `E2E Test Role ${RUN_ID}`, description: 'Created by backoffice-rbac.e2e-spec.ts' },
    });
    testRoleId = role.id;
    createdRoleIds.push(role.id);
  });

  afterAll(async () => {
    await cleanupRbacFixtures(prisma, createdStaffIds, createdRoleIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  describe('RbacManagementController — gated by the LEGACY PlatformRolesGuard', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/backoffice/rbac/roles').expect(401);
    });

    it('rejects a plain authenticated non-staff caller (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/rbac/roles')
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .expect(403);
    });

    it('rejects a REVIEWER-ranked staff member — this surface requires PLATFORM_ADMIN specifically (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/rbac/roles')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);
    });

    it('lets PLATFORM_ADMIN list roles and permissions', async () => {
      const rolesRes = await request(app.getHttpServer())
        .get('/api/v1/backoffice/rbac/roles')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(rolesRes.body.data.some((r: { id: string }) => r.id === testRoleId)).toBe(true);

      const permsRes = await request(app.getHttpServer())
        .get('/api/v1/backoffice/rbac/permissions')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      const permissionKeys = permsRes.body.data.map(
        (permission: { key: string }) => permission.key,
      );

      expect(permissionKeys).toEqual(
        expect.arrayContaining([
          'SUBSCRIPTION_VIEW',
          'SUBSCRIPTION_MANAGE',
        ]),
      );
    });

    it('assigns a role to a staff member, writes an audit entry, and rejects a duplicate active grant (idempotency / conflict)', async () => {
      const assignRes = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/staff/${adminStaffId}/roles`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ roleId: testRoleId })
        .expect(201);
      createdStaffIds.push(adminStaffId);

      const staffRoleId = assignRes.body.data.id;

      // Re-running the exact same grant must NOT create a second active
      // row — this is the practical, application-layer proof of the
      // partial unique index's intent (at most one ACTIVE grant per
      // (staffId, roleId) pair).
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/staff/${adminStaffId}/roles`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ roleId: testRoleId })
        .expect(409);

      const auditRow = await prisma.auditLog.findFirst({
        where: { entityType: 'StaffRole', entityId: staffRoleId, action: 'StaffRoleAssigned' },
      });
      expect(auditRow).not.toBeNull();
      expect(auditRow!.actorId).toBe(admin.personId);

      // Revoke closes the row (history preserved) rather than deleting it.
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/staff-roles/${staffRoleId}/revoke`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(201);

      const closed = await prisma.staffRole.findUnique({ where: { id: staffRoleId } });
      expect(closed).not.toBeNull();
      expect(closed!.revokedAt).not.toBeNull();

      const revokeAuditRow = await prisma.auditLog.findFirst({
        where: { entityType: 'StaffRole', entityId: staffRoleId, action: 'StaffRoleRevoked' },
      });
      expect(revokeAuditRow).not.toBeNull();

      // Re-granting after a revoke must succeed — the partial index only
      // blocks a second ACTIVE row, never a fresh grant after a close.
      const regrantRes = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/staff/${adminStaffId}/roles`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ roleId: testRoleId })
        .expect(201);
      expect(regrantRes.body.data.id).not.toBe(staffRoleId);

      // Test-isolation cleanup: this test's own re-grant above leaves
      // (adminStaffId, testRoleId) ACTIVE. `adminStaffId`/`testRoleId` are
      // shared, `beforeAll`-scoped fixtures reused by later, independent
      // tests in this file (e.g. the `PermissionResolutionController`
      // describe block below) — those tests assume a clean slate for this
      // exact pair. Without this revoke, a later assign of the same pair
      // would find this row still active and correctly 409, which is
      // exactly the failure this comment is here to prevent from
      // regressing (found via a real run — see 21_ADRs > ADR-099).
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/staff-roles/${regrantRes.body.data.id}/revoke`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(201);
    });

    it('grants and revokes a Role<->Permission assignment, writing audit entries for both', async () => {
      const grantRes = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/roles/${testRoleId}/permissions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ permissionKey: 'MARKETPLACE_APPROVE' })
        .expect(201);
      const rolePermissionId = grantRes.body.data.id;

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/roles/${testRoleId}/permissions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ permissionKey: 'MARKETPLACE_APPROVE' })
        .expect(409);

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/role-permissions/${rolePermissionId}/revoke`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(201);

      const closed = await prisma.rolePermission.findUnique({ where: { id: rolePermissionId } });
      expect(closed!.revokedAt).not.toBeNull();
    });
  });

  describe('PermissionResolutionController — GET /backoffice/rbac/me/permissions', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/rbac/me/permissions')
        .expect(401);
    });

    it('returns an empty array for a plain, non-staff authenticated caller', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/backoffice/rbac/me/permissions')
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .expect(200);
      expect(res.body.data.permissions).toEqual([]);
    });

    it('reflects a live grant immediately, and a revocation immediately — no caching, per ADR-098', async () => {
      const assignRes = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/staff/${adminStaffId}/roles`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ roleId: testRoleId })
        .expect(201);
      const staffRoleId = assignRes.body.data.id;

      const grantRes = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/roles/${testRoleId}/permissions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ permissionKey: 'MARKETPLACE_APPROVE' })
        .expect(201);
      const rolePermissionId = grantRes.body.data.id;

      const afterGrant = await request(app.getHttpServer())
        .get('/api/v1/backoffice/rbac/me/permissions')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(afterGrant.body.data.permissions).toContain('MARKETPLACE_APPROVE');

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/role-permissions/${rolePermissionId}/revoke`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(201);

      const afterRevoke = await request(app.getHttpServer())
        .get('/api/v1/backoffice/rbac/me/permissions')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(afterRevoke.body.data.permissions).not.toContain('MARKETPLACE_APPROVE');

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/rbac/staff-roles/${staffRoleId}/revoke`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(201);
    });
  });
});
