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
import { createE2eRunId, E2E_SUITE_ID } from './helpers/e2e-identity';

// 21_ADRs > ADR-111 — User Administration (Stage 4).
// `GET /api/v1/backoffice/users`, `GET /api/v1/backoffice/users/:id`,
// `POST /api/v1/backoffice/users/:id/suspend`, `POST
// /api/v1/backoffice/users/:id/reinstate` all reuse the pre-existing
// USER_VIEW/USER_EDIT permission keys (reserved since ADR-098, never
// wired to a real route until this stage) — no schema/migration change
// this stage, so this suite is the first e2e coverage either key has
// ever had. Two describe blocks, one per permission key, each proving
// the dual-guard gate independently (401/403×2/403-no-grant/granted-
// live/revoked-live — the same shape ADR-108/ADR-109/ADR-110's own e2e
// suites established), plus a functional block proving list/search/
// pagination, detail shape, and the suspend->reinstate round trip
// (including that USER_EDIT reason is mandatory and that a suspended
// Person is immediately blocked from a fresh login, proving this
// endpoint actually engages ADR-043's live isSuspended check, not just
// flipping a flag nothing reads).
const RUN_ID = createE2eRunId(E2E_SUITE_ID.USER_ADMINISTRATION);
let phoneCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
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
  // Same FK-cleanup chain established since ADR-108's own e2e suite.
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

async function requestOtpAndCaptureCodeDirect(
  app: INestApplication,
  phone: string,
  purpose: 'LOGIN' | 'REGISTER' | 'VERIFY_PHONE' = 'LOGIN',
): Promise<string> {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await app.get(AuthService).requestOtp({ phone, purpose }, 'test-direct-otp-request');

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
  deviceToken?: string;
}

async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

const PLATFORM_ADMIN_PHONE = '+989120000000';
const PLATFORM_REVIEWER_PHONE = '+989120000001';

async function loginAsSeededStaff(app: INestApplication, phone: string): Promise<RegisteredPerson> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = await requestOtpAndCaptureCodeDirect(app, phone);
    const deviceToken = `e2e-${phone}-${code}`;
    const res = await verifyOtp(app, { phone, code });
    if (res.status === 200) {
      return {
        phone,
        personId: res.body.data.personId,
        accessToken: res.body.data.accessToken,
        deviceToken,
      };
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

async function deleteStaffLoginArtifactsOnceBatch(
  prisma: PrismaService,
  phones: string[],
  deviceTokens: string[],
): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { device: { deviceToken: { in: deviceTokens } } },
  });
  await prisma.device.deleteMany({ where: { deviceToken: { in: deviceTokens } } });
  await prisma.otpRequest.deleteMany({
    where: {
      phone: { in: phones },
      OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: new Date() } }],
    },
  });
}

async function cleanupStaffLoginArtifacts(
  prisma: PrismaService,
  phones: string[],
  deviceTokens: string[],
): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteStaffLoginArtifactsOnceBatch(prisma, phones, deviceTokens);
      return;
    } catch (error) {
      const isForeignKeyError =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!isForeignKeyError || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

describe('User Administration (e2e) — Backoffice User List/Detail/Suspend/Reinstate (ADR-111)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let targetPerson: RegisteredPerson;

  let viewRoleId: string;
  let viewPermissionId: string;
  let viewStaffRoleGrantId: string;

  let editRoleId: string;
  let editPermissionId: string;
  let editStaffRoleGrantId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
    staffDeviceTokens.push(admin.deviceToken!);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
    staffDeviceTokens.push(reviewer.deviceToken!);

    plainPerson = await registerPerson(app);
    createdPhones.push(plainPerson.phone);

    targetPerson = await registerPerson(app);
    createdPhones.push(targetPerson.phone);

    const viewPermission =
      (await prisma.permission.findUnique({ where: { key: 'USER_VIEW' } })) ??
      (await prisma.permission.create({ data: { key: 'USER_VIEW', label: 'USER_VIEW' } }));
    viewPermissionId = viewPermission.id;

    const viewRole = await prisma.role.create({
      data: {
        name: `E2E ADR-111 User-View Test Role ${Date.now()}`,
        description: 'Created by user-administration.e2e-spec.ts (ADR-111).',
      },
    });
    viewRoleId = viewRole.id;

    const reviewerStaff = await prisma.platformStaff.findUnique({
      where: { personId: reviewer.personId },
    });
    const viewGrant = await prisma.staffRole.create({
      data: { staffId: reviewerStaff!.id, roleId: viewRoleId },
    });
    viewStaffRoleGrantId = viewGrant.id;

    const editPermission =
      (await prisma.permission.findUnique({ where: { key: 'USER_EDIT' } })) ??
      (await prisma.permission.create({ data: { key: 'USER_EDIT', label: 'USER_EDIT' } }));
    editPermissionId = editPermission.id;

    const editRole = await prisma.role.create({
      data: {
        name: `E2E ADR-111 User-Edit Test Role ${Date.now()}`,
        description: 'Created by user-administration.e2e-spec.ts (ADR-111).',
      },
    });
    editRoleId = editRole.id;

    const adminStaff = await prisma.platformStaff.findUnique({
      where: { personId: admin.personId },
    });
    const editGrant = await prisma.staffRole.create({
      data: { staffId: adminStaff!.id, roleId: editRoleId },
    });
    editStaffRoleGrantId = editGrant.id;
    // Neither test role has any RolePermission yet — both staff members
    // hold the legacy rank each route requires (REVIEWER for view routes,
    // PLATFORM_ADMIN for edit routes) but no RBAC permission at all,
    // deliberately, to prove PermissionsGuard enforces independently of
    // the legacy rank check.
  });

  afterAll(async () => {
    if (viewStaffRoleGrantId) {
      await prisma.staffRole.delete({ where: { id: viewStaffRoleGrantId } });
    }
    if (viewRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: viewRoleId } });
      await prisma.role.delete({ where: { id: viewRoleId } });
    }
    if (editStaffRoleGrantId) {
      await prisma.staffRole.delete({ where: { id: editStaffRoleGrantId } });
    }
    if (editRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: editRoleId } });
      await prisma.role.delete({ where: { id: editRoleId } });
    }
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  describe('List & Detail (USER_VIEW)', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/backoffice/users').expect(401);
    });

    it('rejects a plain, non-staff authenticated caller (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/users')
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .expect(403);
    });

    it('rejects REVIEWER-ranked staff while holding a role with NO granted permission (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/users')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/v1/backoffice/users/${targetPerson.personId}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);
    });

    it('granting USER_VIEW takes effect immediately — list is paginated/searchable and detail returns the real profile', async () => {
      await prisma.rolePermission.create({
        data: { roleId: viewRoleId, permissionId: viewPermissionId },
      });

      const listRes = await request(app.getHttpServer())
        .get(
          `/api/v1/backoffice/users?search=${encodeURIComponent(targetPerson.phone)}&page=1&limit=10`,
        )
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(Array.isArray(listRes.body.data)).toBe(true);
      expect(listRes.body.data.some((p: { id: string }) => p.id === targetPerson.personId)).toBe(
        true,
      );
      expect(listRes.body.metadata.pagination).toEqual(
        expect.objectContaining({ page: 1, limit: 10, total: expect.any(Number) }),
      );

      const detailRes = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/users/${targetPerson.personId}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(detailRes.body.data.id).toBe(targetPerson.personId);
      expect(detailRes.body.data.phone).toBe(targetPerson.phone);
      expect(typeof detailRes.body.data.isSuspended).toBe('boolean');
      expect(typeof detailRes.body.data.isBackofficeApproved).toBe('boolean');
      expect(Array.isArray(detailRes.body.data.memberships)).toBe(true);
    });

    it('returns 404 for an unknown personId', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/users/does-not-exist')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(404);
    });

    it('21_ADRs > ADR-115 — /export rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/backoffice/users/export').expect(401);
    });

    it('21_ADRs > ADR-115 — GET /export returns a CSV of the same filtered result set, gated by the same USER_VIEW grant', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/users/export?search=${encodeURIComponent(targetPerson.phone)}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.split('\n')[0]).toBe(
        'id,phone,email,fullName,firstName,lastName,isSuspended,isBackofficeApproved,createdAt',
      );
      expect(res.text).toContain(targetPerson.personId);
      expect(res.text).toContain(targetPerson.phone);
    });

    it('revoking USER_VIEW takes effect immediately — the route closes again, live and uncached', async () => {
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId: viewRoleId, permissionId: viewPermissionId, revokedAt: null },
      });
      await prisma.rolePermission.update({
        where: { id: activeGrant!.id },
        data: { revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .get('/api/v1/backoffice/users')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);
    });
  });

  describe('Suspend & Reinstate (USER_EDIT)', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/suspend`)
        .send({ reason: 'test' })
        .expect(401);
    });

    it('rejects a plain, non-staff authenticated caller (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/suspend`)
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('rejects REVIEWER (rank 1, below required SENIOR_REVIEWER) regardless of permission (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/suspend`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('rejects the PLATFORM_ADMIN-ranked staff member while holding a role with NO granted permission (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/suspend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('granting USER_EDIT takes effect immediately — rejects a missing reason with 400', async () => {
      await prisma.rolePermission.create({
        data: { roleId: editRoleId, permissionId: editPermissionId },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/suspend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({})
        .expect(400);
    });

    it('suspends the target with a real reason, and the suspended Person is immediately blocked from a fresh login', async () => {
      // 201, not 200 — NestJS's default @Post() status, unchanged here,
      // matching PersonAccessController.set()'s own identical
      // POST-mutation-on-an-existing-Person shape and its own e2e
      // suite's `.expect(201)` for the same reason.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/suspend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'ADR-111 e2e proof — suspected fraud.' })
        .expect(201);

      expect(res.body.data).toEqual({ personId: targetPerson.personId, isSuspended: true });

      // ADR-043's live isSuspended check on the auth path — a fresh OTP
      // login attempt for this exact Person must now fail, proving this
      // endpoint actually engages the real enforcement mechanism, not
      // just a flag nothing reads.
      const code = await requestOtpAndCaptureCode(app, targetPerson.phone);
      await verifyOtp(app, { phone: targetPerson.phone, code }).expect(403);
    });

    it('returns stable conflicts for self-suspend and a repeated suspend', async () => {
      const self = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${admin.personId}/suspend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'self target' })
        .expect(409);
      expect(self.body.errors[0].code).toBe('CONFLICT');

      const repeated = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/suspend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'duplicate' })
        .expect(409);
      expect(repeated.body.errors[0].code).toBe('CONFLICT');
    });

    it('reinstates the target — a fresh login succeeds again', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/reinstate`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'ADR-111 e2e proof — appeal upheld.' })
        .expect(201);

      expect(res.body.data).toEqual({ personId: targetPerson.personId, isSuspended: false });

      const code = await requestOtpAndCaptureCode(app, targetPerson.phone);
      await verifyOtp(app, { phone: targetPerson.phone, code }).expect(200);
    });

    it('returns a stable conflict for repeated reinstate', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/reinstate`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'duplicate' })
        .expect(409);
      expect(res.body.errors[0].code).toBe('CONFLICT');
    });

    it('revoking USER_EDIT takes effect immediately — the route closes again, live and uncached', async () => {
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId: editRoleId, permissionId: editPermissionId, revokedAt: null },
      });
      await prisma.rolePermission.update({
        where: { id: activeGrant!.id },
        data: { revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/users/${targetPerson.personId}/suspend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });
  });
});
